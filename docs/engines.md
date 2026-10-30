# Engines

Litegres separates the **control plane** (sessions, leases, templates, the
reaper, the HTTP API) from the **engine** that actually hosts databases.
Pick one with `--engine` / `LITEGRES_ENGINE`.

| | `native` (default) | `pglite` |
|---|---|---|
| Backing | one real PostgreSQL server, one database per Litegres database | one PGlite (WASM) instance + socket server per database |
| Clone | `CREATE DATABASE ... TEMPLATE` (~15 ms) | restore a snapshot (~70 ms) |
| Parallelism | real: every connection is its own backend process | none: all databases share one thread |
| Memory (16 live DBs) | ~60 MiB daemon + the Postgres server (~150 MiB) | ~3.6 GiB |
| Reset in place (`POST /v1/databases/{id}/reset`) | yes (~15 ms) | no (`501`) |
| Extensions, LISTEN/NOTIFY, advisory locks, row-lock concurrency | yes (whatever the server has) | no |
| Needs | a PostgreSQL 13+ server (URL, or Docker) | nothing |

Why native is the default: see `spike/phase0/RESULTS.md`. PGlite serializes
every connection of a database, so Flyway, pooled connection use, prepared
statements and `SKIP LOCKED` workers all misbehave against it; the same Spring
Boot + Flyway + JPA suite passes 48/48 on native and 17/48 on PGlite.

## Native engine

```bash
# 1. bring your own server (local install, CI service container, Postgres.app)
litegresd run --postgres-url postgresql://postgres:secret@127.0.0.1:5432/postgres

# 2. or let the daemon start a throwaway container (needs Docker)
litegresd run
```

With no `--postgres-url` the daemon starts one `postgres:17-alpine` container
(`litegres-postgres`) on a random loopback port, tuned for disposable data
(`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`), and removes
it on shutdown. A container that is already running is reused and left
alone. `--keep-postgres` keeps the one we started; `--postgres-image` picks
another image; `--postgres-docker false` forbids starting one.

How it maps onto Postgres:

- database -> `CREATE DATABASE <prefix><id> [TEMPLATE <template db>]`
- template -> a real database, sealed with `ALLOW_CONNECTIONS false` once
  finalized so it is immutable and cloneable
- delete   -> `DROP DATABASE ... WITH (FORCE)`
- clients connect straight to the server's own port (no proxy); the
  connection info carries that port and the per-database name

### Ownership, crash recovery, multiple daemons

Every database the daemon creates is named
`<--name-prefix><owner tag>_<id>` (prefix defaults to `litegres_`). The owner
tag identifies the daemon instance, which holds a Postgres advisory lock on it
for as long as it lives:

- on startup a daemon drops the databases with its prefix whose owner **no
  longer holds the lock** (a crashed daemon's connection dies, releasing it)
  and any with no owner tag;
- databases of a **live** daemon are never touched, so several daemons (a
  local one, a Gradle-launched one, CI jobs) can share one server and even one
  prefix;
- never choose a prefix that matches databases you care about: those are
  dropped as orphans.

### Credentials

Clients receive the **admin credentials of the configured server**, not a
per-database role. Point Litegres only at a disposable server; it is a test
fixture, not a multi-tenant service. (The PGlite engine still generates a
password per database, but it is not enforced there either.)

### Requirements

PostgreSQL 13 or newer (`DROP DATABASE ... WITH (FORCE)`). Connections use
plain TCP without TLS.

## PGlite engine

Kept for Docker-free, in-process use and for compatibility with existing
setups. See [compatibility.md](compatibility.md) for what it cannot do. It
will be removed once the native engine has proven itself.
