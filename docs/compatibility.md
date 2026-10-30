# Compatibility

Databases are real databases on a real PostgreSQL server (see
[postgres.md](postgres.md)), so everything that works on that server works
here: concurrent sessions, row locks, deadlock detection, advisory locks,
`LISTEN/NOTIFY`, `SKIP LOCKED`, extensions installed on the server, any client
library, Flyway/Liquibase/Prisma/Alembic.

The Phase 0 suite (`spike/phase0`) exercises, over Spring Boot + Flyway + JPA:
concurrent row-locked transfers, `SKIP LOCKED` workers, deadlock detection,
row-lock waits, read-committed isolation, rollback isolation between
connections, temp tables, and advisory locks. All pass.

## Differences from "a Postgres of your own"

- **Shared server credentials.** Every database is reachable with the
  server's admin login. Do not point Litegres at a server you care about.
- **Shared server resources.** `max_connections`, `shared_buffers` and CPU
  are shared by every database; size the server for your parallelism. A test
  that exhausts connections affects its neighbours.
- **Cluster-level objects are shared**: roles, tablespaces, and
  `ALTER SYSTEM` settings are not per database.
- **Template cloning copies files**, so very large templates clone slower
  than the ~15 ms of a small schema.
- **No TLS** between client and server.
- **Test-tuned durability** on the managed container (`fsync=off`): data does
  not survive a crash, which is the point.

## Recommended strategy

Run your integration suite on Litegres. Keep one smoke run of the exact
production Postgres version, extensions and TLS setup in CI for what a shared
test server can't cover.
