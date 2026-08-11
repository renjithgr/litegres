# Litegres

> Litegres is a local daemon that creates disposable PostgreSQL-compatible databases backed by [PGlite](https://pglite.dev).

**One lightweight daemon. Many isolated Postgres-compatible databases.**

Instead of starting one Docker container or one OS process per test database,
Litegres starts once and manages many isolated PGlite instances inside that
process. A test framework asks the daemon for a database through a small HTTP
control API and gets back ordinary PostgreSQL connection details; the test's
normal PostgreSQL client then talks to the database over the standard wire
protocol.

```
Test runners and applications
             │
             │ Control API (HTTP, localhost)
             ▼
┌─────────────────────────────────────────────┐
│ Litegres daemon                            │
│                                             │
│ Session and database registry               │
│                                             │
│ ├── template_accounting_v12                 │
│ ├── db_test_01 → PGlite instance            │
│ ├── db_test_02 → PGlite instance            │
│ └── db_test_03 → PGlite instance            │
│                                             │
│ Each database has its own PG wire endpoint  │
└─────────────────────────────────────────────┘
       │               │               │
       ▼               ▼               ▼
  PG port 49152    PG port 49153    PG port 49154
```

## Why it exists

Automated tests need real databases. The usual options are heavy:

- **Docker Testcontainers**: pull images, wait for container readiness,
  manage a Docker daemon in CI — seconds per database.
- **System PostgreSQL**: shared server state, cross-test contamination,
  permission wrangling.

Litegres targets the middle ground: **fast, disposable, isolated,
PostgreSQL-compatible databases for automated tests**, with no Docker and no
OS process per database. Databases are created in ~100–500 ms, live for a
configurable lease, and are destroyed automatically when the test run ends
or the lease expires.

## Control plane vs data plane

- **Control plane** — an HTTP API on `127.0.0.1` (default port `49100`) that
  creates, clones, inspects, leases, and destroys sessions, templates, and
  databases. JSON in, JSON out, OpenAPI 3.1 spec in `docs/openapi.yaml`.
- **Data plane** — one TCP port per database speaking the standard PostgreSQL
  wire protocol. Ordinary SQL goes straight to PostgreSQL; it is never
  routed through HTTP.

## Quick start (30 seconds)

```bash
# 1. install
bun install

# 2. start the daemon (foreground)
bun run src/main.ts run
# or, after building: ./dist/litegresd run

# 3. in another terminal — create a session
curl -s -X POST http://127.0.0.1:49100/v1/sessions \
  -H "Authorization: Bearer $(cat ~/.local/state/litegres/token)" \
  -H "Content-Type: application/json" \
  -d '{"ttlSeconds": 1800}'

# 4. create a database (use the session id from step 3)
curl -s -X POST http://127.0.0.1:49100/v1/databases \
  -H "Authorization: Bearer $(cat ~/.local/state/litegres/token)" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"ses_...","ttlSeconds":600}'

# 5. connect with psql (copy the port from the response)
psql "postgresql://postgres:generated-secret@127.0.0.1:PORT/postgres"
```

## Starting the daemon

```bash
litegresd run                # foreground
litegresd start              # foreground (same as run in the MVP)
litegresd start --background # detached, logs to the runtime dir
litegresd status             # show daemon status
litegresd stop               # graceful shutdown
```

The daemon writes a discovery file so clients can find it:

```text
$XDG_RUNTIME_DIR/litegres/daemon.json   (or ~/.local/state/litegres on macOS)
```

See [docs/security.md](docs/security.md) for the runtime directory layout,
the token file, and the single-daemon lock.

## Creating a session

```bash
curl -X POST http://127.0.0.1:49100/v1/sessions \
  -H "Authorization: Bearer <daemon-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "client": { "name": "brisk-core-tests", "version": "0.1.0", "framework": "junit5" },
    "ttlSeconds": 1800,
    "metadata": { "gitCommit": "abc123" }
  }'
```

A session represents one test run or one client process. It returns a
`leaseToken` used for scoped authentication. Deleting a session destroys
every database it owns.

## Creating a database

```bash
curl -X POST http://127.0.0.1:49100/v1/databases \
  -H "Authorization: Bearer <daemon-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "ses_...",
    "ttlSeconds": 600,
    "initialization": {
      "statements": ["CREATE TABLE accounts (id bigint primary key, name text not null)"]
    }
  }'
```

The response contains ordinary connection details:

```json
{
  "id": "db_01K2ABCDEF",
  "status": "ready",
  "connection": {
    "host": "127.0.0.1",
    "port": 49152,
    "database": "postgres",
    "username": "postgres",
    "password": "generated-secret",
    "postgresUrl": "postgresql://postgres:generated-secret@127.0.0.1:49152/postgres",
    "jdbcUrl": "jdbc:postgresql://127.0.0.1:49152/postgres?sslmode=disable"
  },
  "createdAt": "2026-08-06T17:45:00Z",
  "expiresAt": "2026-08-06T17:55:00Z",
  "metadata": {}
}
```

Credentials are returned **only** in the creation response; list and get
responses never include passwords.

## Connecting

**psql** (data plane is plain PostgreSQL):

```bash
psql "postgresql://postgres:generated-secret@127.0.0.1:49152/postgres"
```

**JDBC** (data plane is plain PostgreSQL):

```text
jdbc:postgresql://127.0.0.1:49152/postgres?sslmode=disable
```

**Java client + JUnit 5** (see `jvm/`):

```java
@RegisterExtension
static LitegresExtension postgres = LitegresExtension.empty();

@Test
void insertsAnAccount(LitegresDatabase db) throws Exception {
    try (Connection conn = DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
         Statement st = conn.createStatement()) {
        st.execute("INSERT INTO accounts VALUES (1, 'alice')");
    }
}
```

Every test method gets its own disposable database; one session per class,
one clone per test from a template when using `fromTemplate(...)`. See
`jvm/README.md` for the full API, provisioning with Flyway/Liquibase/Prisma,
and Spring Boot wiring.

**TypeScript client** (see `clients/typescript`):

```ts
import { LitegresClient } from "@litegres/client";

const client = await LitegresClient.connect(); // discovers the daemon + token

const session = await client.createSession({
  client: { name: "example-tests", framework: "bun:test" },
});

const database = await client.createDatabase({
  sessionId: session.id,
  ttlSeconds: 600,
});

console.log(database.connection.postgresUrl);
await client.deleteSession(session.id);
```

## Sessions and cleanup

- Databases belong to sessions; deleting a session destroys its databases.
- Every database and session has a TTL. A background **reaper** expires
  leases and closes leaked instances, so a crashed test runner cannot leak
  databases forever.
- Renew a lease:

```bash
curl -X POST http://127.0.0.1:49100/v1/databases/db_.../renew \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"ttlSeconds": 600}'
```

Defaults: database TTL 10 min (max 1 h), session TTL 30 min (max 4 h),
reaper every 10 s — all configurable.

## Templates and cloning

Templates are prepared PGlite snapshots that clone into isolated databases.
Two ways to create one:

**1. From statements (idempotent by fingerprint):**

```bash
curl -X PUT http://127.0.0.1:49100/v1/templates/sha256%3A5f6a \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{
    "name": "brisk-core",
    "initialization": {
      "statements": ["CREATE TABLE accounts (...)", "CREATE TABLE journal_entries (...)"]
    }
  }'
```

If a healthy template with the same fingerprint exists, it is returned
instead of building another.

**2. External provisioning (Flyway, Liquibase, Prisma, Diesel, Alembic...):**

```bash
# start provisioning — get a temporary PostgreSQL endpoint
curl -X POST http://127.0.0.1:49100/v1/templates \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"brisk-core","fingerprint":"sha256:5f6a"}'

# run your migrations with your normal tooling against that endpoint
# (flyway migrate -url=jdbc:postgresql://127.0.0.1:PORT/postgres ...)

# finalize: endpoint closes, template becomes immutable and cloneable
curl -X POST http://127.0.0.1:49100/v1/templates/tpl_.../finalize \
  -H "Authorization: Bearer <token>"
```

Clone a template into a disposable database:

```bash
curl -X POST http://127.0.0.1:49100/v1/databases \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"sessionId":"ses_...","templateId":"tpl_...","ttlSeconds":600}'
```

Clones are isolated from each other and from the template; changes to one
clone never appear in another. Templates are immutable after finalize.

## Configuration

Precedence: **CLI args > environment > config file > defaults**.

```bash
litegresd run \
  --host 127.0.0.1 \
  --port 49100 \
  --max-databases 32 \
  --max-templates 8 \
  --database-ttl 600 \
  --session-ttl 1800
```

Environment variables:

```text
LITEGRES_HOST, LITEGRES_PORT, LITEGRES_MAX_DATABASES, LITEGRES_MAX_TEMPLATES,
LITEGRES_MAX_DATABASES_PER_SESSION, LITEGRES_DATABASE_TTL_SECONDS,
LITEGRES_MAX_DATABASE_TTL_SECONDS, LITEGRES_SESSION_TTL_SECONDS,
LITEGRES_MAX_SESSION_TTL_SECONDS, LITEGRES_REAPER_INTERVAL_SECONDS,
LITEGRES_RUNTIME_DIR, LITEGRES_LOG_LEVEL, LITEGRES_LOG_FORMAT,
LITEGRES_CONTROL_TOKEN, LITEGRES_CONFIG_FILE
```

A JSON config file (`--config-file`) is also supported. Invalid configuration
fails at startup with actionable errors.

## Security model

Litegres is a **local development and testing service**, not a secure
multi-tenant hosting platform.

- Control API binds to `127.0.0.1`; `0.0.0.0` is rejected by default.
- All `/v1` mutations require the daemon control token (`Authorization:
  Bearer <token>`), or a session lease token scoped to that session.
- The token is generated at startup and stored in a `chmod 600` file.
- Runtime metadata lives in a user-only runtime directory with atomic writes
  and a single-daemon lock.
- Database passwords are generated per database and redacted from logs.

See [docs/security.md](docs/security.md) for details.

## Compatibility limitations

Litegres and PGlite are **not native PostgreSQL**. Do not use Litegres to
validate realistic concurrent sessions, deadlocks, lock contention,
connection-pool exhaustion, replication, failover, WAL behavior, SSL
behavior, arbitrary extensions, native performance, OS integration, or
production correctness.

Recommended two-layer strategy:

```text
Fast test suite:      Litegres on every local run and pull request.
Compatibility suite:  Native PostgreSQL through Testcontainers or CI infra.
```

See [docs/compatibility.md](docs/compatibility.md) for the full list.

## Litegres vs Testcontainers

| | Litegres (PGlite) | Testcontainers (native Postgres) |
|---|---|---|
| Docker required | no | yes |
| First database | ~100–500 ms | seconds (image pull + boot) |
| Isolation | process-local, snapshot-based | OS processes/containers |
| Fidelity | PostgreSQL 18 engine, single-process semantics | full PostgreSQL |
| Use for | fast disposable tests | compatibility/behavior suites |

## Troubleshooting

- **"No Litegres daemon discovery file found"** — the daemon is not running;
  start it with `litegresd run` or pass `controlUrl`/`runtimeDirOverride`.
  For the Java/JUnit tests this means the `-PlitegresRuntimeDir=<path>`
  points somewhere other than where the daemon wrote its `daemon.json`;
  see `jvm/README.md` “What `-PlitegresRuntimeDir=<path>` means” for how
  to find the right value.
- **Port 49100 in use** — another daemon may be running (`litegresd status`),
  or configure a different port with `--port`.
- **"Another Litegres daemon owns ..."** — a live daemon already claims the
  runtime dir; use `litegresd stop` first or a different `--runtime-dir`.
- **High memory** — each PGlite instance reserves WASM memory; keep
  `maxDatabases` bounded and prefer template clones over empty instances.
  See [docs/architecture.md](docs/architecture.md).

## Roadmap

- Worker sharding (multiple workers owning disjoint databases)
- Shared-port PostgreSQL router (one port, virtual routing)
- Prometheus metrics endpoint
- Rust / Go / Python / Ruby clients and framework extensions
  (integration pattern documented in `docs/client-integrations.md`;
  the JVM client + JUnit 5 extension already live in `jvm/`)
- Cross-platform CI matrix (Linux x86-64 first)

## Development

```bash
bun install
bun run typecheck     # bunx tsc --noEmit
bun run lint          # typecheck + hygiene checks
bun test              # unit + integration + compatibility (test/)
bun run integration-test
bun run process-test  # compiled binary from a clean directory
bun run build         # standalone executable -> dist/litegresd
bun run benchmark     # machine-specific timing numbers
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the docs in `docs/`.

## License

Apache-2.0. Litegres bundles PGlite (Apache-2.0), which embeds PostgreSQL
under its own license.
