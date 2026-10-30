# PostgreSQL server

Litegres separates the **control plane** (sessions, leases, templates, the
reaper, the HTTP API) from the **PostgreSQL server** that hosts the databases.
There is exactly one server; every Litegres database is a database on it, and
clients connect to it directly over the ordinary wire protocol.

Why this design: see `spike/phase0/RESULTS.md`. Real Postgres with
`CREATE DATABASE ... TEMPLATE` clones a migrated schema in ~15 ms, uses a few
MiB per database, runs every connection as its own backend (real concurrency,
locks, extensions), and passed a Spring Boot + Flyway + JPA suite 48/48. (An
in-process WebAssembly Postgres was evaluated and removed: it serialized all
connections of a database and failed 31 of those 48 tests.)

## Choosing the server

```bash
# 1. bring your own (local install, CI service container, Postgres.app)
litegresd run --postgres-url postgresql://postgres:secret@127.0.0.1:5432/postgres

# 2. or let the daemon start a throwaway container (needs Docker)
litegresd run
```

With no `--postgres-url` the daemon starts one `postgres:17-alpine` container
(`litegres-postgres`) on a random loopback port, tuned for disposable data
(`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`), and removes it
on shutdown. A container that is already running is reused and left alone.
`--keep-postgres` keeps the one we started; `--postgres-image` picks another
image; `--postgres-docker false` forbids starting one.

The server must be PostgreSQL 13 or newer (`DROP DATABASE ... WITH (FORCE)`)
and reachable over plain TCP without TLS.

## How it maps onto Postgres

- database -> `CREATE DATABASE <prefix><owner>_<id> [TEMPLATE <template db>]`
- template -> a real database, sealed with `ALLOW_CONNECTIONS false` once
  finalized so it is immutable and cloneable
- reset    -> drop and recreate from the template under the same name
- delete   -> `DROP DATABASE ... WITH (FORCE)`
- clients connect straight to the server's own port (no proxy); the
  connection info carries that port and the per-database name

## Ownership, crash recovery, multiple daemons

Every database name is `<--name-prefix><owner tag>_<id>` (prefix defaults to
`litegres_`). The owner tag identifies the daemon instance, which holds a
Postgres advisory lock on it for as long as it lives:

- on startup a daemon drops the databases with its prefix whose owner **no
  longer holds the lock** (a crashed daemon's connection dies, releasing it)
  and any with no owner tag;
- databases of a **live** daemon are never touched, so several daemons (a
  local one, a Gradle-launched one, CI jobs) can share one server and even one
  prefix;
- never choose a prefix that matches databases you care about: those are
  dropped as orphans.

## Credentials

Clients receive the **admin credentials of the configured server**, not a
per-database role. Point Litegres only at a disposable server; it is a test
fixture, not a multi-tenant service.

## Shared server, shared limits

`max_connections`, `shared_buffers` and CPU are shared by every database, so
size the server for your parallelism (the managed container sets
`max_connections=300`). Cluster-level objects (roles, tablespaces,
`ALTER SYSTEM`) are not per database.

## Container image

The repository's `Dockerfile` builds an image with PostgreSQL 17 and the
daemon together: `docker run -p 49100:49100 -p 5432:5432 litegres/litegresd`.
Publish 5432 on another host port with `LITEGRES_PUBLIC_PORT`. See
`jvm/README.md` for the Testcontainers-style `LitegresContainer`.
