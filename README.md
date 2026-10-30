# Litegres

> Litegres is a local daemon that hands out disposable, isolated PostgreSQL databases in milliseconds, cloned from a migrated template on one real PostgreSQL server.

**One PostgreSQL server. Many isolated databases. No container per test.**

Instead of starting one Docker container per test class, Litegres keeps one
PostgreSQL server running and manages many isolated databases inside it. A
test framework asks the daemon for a database through a small HTTP control
API and gets back ordinary PostgreSQL connection details; the test's normal
PostgreSQL client then talks to the database over the standard wire
protocol. Databases are cloned from a prepared **template** with
`CREATE DATABASE ... TEMPLATE`, so a migrated schema costs ~15 ms per
database instead of re-running migrations.

```
Test runners and applications
             │
             │ Control API (HTTP, localhost)
             ▼
┌─────────────────────────────────────────────┐
│ Litegres daemon                             │
│  sessions · leases · templates · reaper     │
│                                             │
│  engine (native)                            │
└──────────────────────┬──────────────────────┘
                       │ CREATE / DROP DATABASE
                       ▼
┌─────────────────────────────────────────────┐
│ One PostgreSQL server                       │
│ ├── litegres_tpl_accounting  (template)     │
│ ├── litegres_db_test_01  ◄── clone          │
│ ├── litegres_db_test_02  ◄── clone          │
│ └── litegres_db_test_03  ◄── clone          │
└─────────────────────────────────────────────┘
        ▲               ▲               ▲
        └─ tests connect directly (wire protocol, real backends)
```

## Why it exists

Integration tests need real databases, and the usual options hurt at scale:

- **One Testcontainer per test class**: seconds each, and many at once slow
  the machine down.
- **One shared container**: tests contaminate each other's state, so you
  cannot run them in parallel without managing that state by hand.

Litegres gives every test (or parallel worker) its **own isolated database**
on **one shared server**: real PostgreSQL semantics (concurrent sessions,
locks, extensions), created and destroyed in milliseconds, cleaned up
automatically when the run ends or the lease expires.

## Control plane vs data plane

- **Control plane** — an HTTP API on `127.0.0.1` (default port `49100`) that
  creates, clones, inspects, leases, and destroys sessions, templates, and
  databases. JSON in, JSON out, OpenAPI 3.1 spec in `docs/openapi.yaml`.
- **Data plane** — the PostgreSQL server itself. Each database has its own
  name on the server's port and speaks the standard wire protocol. Ordinary
  SQL goes straight to PostgreSQL; it is never routed through HTTP.

## Quick start (30 seconds)

```bash
# 1. install
bun install

# 2. start the daemon (foreground). It needs a PostgreSQL server:
#    either point it at one ...
bun run src/main.ts run --postgres-url postgresql://postgres:secret@127.0.0.1:5432/postgres
#    ... or let it start a throwaway postgres container (needs Docker)
bun run src/main.ts run
# after building: ./dist/litegresd run

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
litegresd run                # foreground (starts a postgres container unless --postgres-url is given)
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

Templates are prepared, immutable databases that clone into isolated databases
(`CREATE DATABASE ... TEMPLATE` on the native engine).
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
LITEGRES_CONTROL_TOKEN, LITEGRES_CONFIG_FILE,
LITEGRES_ENGINE, LITEGRES_POSTGRES_URL, LITEGRES_POSTGRES_DOCKER,
LITEGRES_KEEP_POSTGRES, LITEGRES_POSTGRES_IMAGE, LITEGRES_NAME_PREFIX
```

See [docs/engines.md](docs/engines.md) for the engine options. A JSON config file (`--config-file`) is also supported. Invalid configuration
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

## Compatibility

With the default **native** engine every database is a real database on a
real PostgreSQL server, so concurrency, locks, extensions and every client
library behave as on any Postgres. Things to know: clients receive the
server's admin credentials, all databases share the server's resources
(`max_connections`, CPU), and there is no TLS. Use a disposable server.

The legacy `--engine pglite` mode (PostgreSQL compiled to WebAssembly) is
much weaker: it serializes all connections of a database, lacks extensions,
and breaks Flyway under default settings.

See [docs/compatibility.md](docs/compatibility.md) and
[docs/engines.md](docs/engines.md).

## Litegres vs Testcontainers

| | Litegres (native engine) | Testcontainers (one container per class) |
|---|---|---|
| Docker required | one container, or none with your own server | yes |
| New isolated database | ~15 ms | seconds |
| Memory for 16 isolated databases | ~210 MiB total | 16 containers |
| Parallel test workers | one database each, one shared server | one container each |
| Fidelity | real PostgreSQL | real PostgreSQL |

Measured with `spike/phase0` (Spring Boot + Flyway + JPA suite, 48 tests):
20 s serial / 11 s at 4 forks, and the same on the Litegres daemon (19 s / 10 s).

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
- **"No PostgreSQL server configured and Docker is not available"** — pass
  `--postgres-url` (or `LITEGRES_POSTGRES_URL`) or start Docker.
- **My databases vanished on daemon start** — on startup the daemon drops
  databases whose name starts with `--name-prefix` (default `litegres_`) and
  whose owning daemon is gone, to clean up after crashes. Databases of a live
  daemon are safe. Never use a prefix that matches databases you care about.

## Roadmap

- Publish `litegresd` release binaries and the JVM modules (Maven Central), then let the launcher download the binary
- Remove the PGlite engine once native has proven itself
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
bun test              # unit + integration + compatibility on the PGlite engine
LITEGRES_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bun test
                      # same suite on the native engine (disposable server!)
bun run integration-test
bun run process-test  # compiled binary from a clean directory
bun run build         # standalone executable -> dist/litegresd
bun run benchmark     # machine-specific timing numbers
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the docs in `docs/`.

## License

Apache-2.0. Litegres bundles PGlite (Apache-2.0), which embeds PostgreSQL
under its own license.
