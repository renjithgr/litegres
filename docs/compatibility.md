# Compatibility

What you can rely on depends on the [engine](engines.md).

## Native engine (default)

Databases are real databases on a real PostgreSQL server, so everything that
works on that server works here: concurrent sessions, row locks, deadlock
detection, advisory locks, `LISTEN/NOTIFY`, `SKIP LOCKED`, extensions
installed on the server, any client library, Flyway/Liquibase/Prisma/Alembic.

The Phase 0 suite (`spike/phase0`) exercises, over Spring Boot + Flyway +
JPA: concurrent row-locked transfers, `SKIP LOCKED` workers, deadlock
detection, row-lock waits, read-committed isolation, rollback isolation
between connections, temp tables, and advisory locks. All pass.

Differences from "a Postgres of your own":

- **Shared server credentials.** Every database is reachable with the
  server's admin login. Do not point Litegres at a server you care about.
- **Shared server resources.** `max_connections`, `shared_buffers` and CPU
  are shared by every database; size the server for your parallelism. A
  test that exhausts connections affects its neighbours.
- **Cluster-level objects are shared**: roles, tablespaces, and
  `ALTER SYSTEM` settings are not per database.
- **Template cloning copies files**, so very large templates clone slower
  than the ~15 ms of a small schema.
- No TLS between client and server.

## PGlite engine

PGlite is PostgreSQL compiled to WebAssembly, run single-process.

| Area | Behaviour |
|---|---|
| Concurrent connections to one database | share one session: a transaction open on one connection blocks every other connection; temp tables, advisory locks, `SET` and session-level prepared statements are shared |
| Flyway (default config) | hangs (its two connections block each other) |
| pgjdbc default settings | server-side prepared statements collide across connections (`prepared statement "S_1" already exists`); needs `prepareThreshold=0` |
| Deadlocks / lock contention | not representative |
| Extensions | only those bundled with PGlite (none in the standalone binary) |
| `LISTEN/NOTIFY` | not delivered |
| Parallelism | none; all databases run on one thread |
| Memory | ~200-300 MiB per active database |
| Auth | `trust`; passwords are generated but not enforced |
| SSL / replication / WAL | not supported |

Measured numbers: `spike/phase0/RESULTS.md`.

## Recommended strategy

Run your integration suite on the native engine. Keep one smoke run of the
exact production Postgres version and extensions in CI for what a shared
test server can't cover (TLS, tuned settings, production extensions).
