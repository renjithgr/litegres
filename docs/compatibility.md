# Compatibility

Litegres and PGlite are **not native PostgreSQL**. This document states what
is and is not safe to validate with Litegres, and how to combine it with a
native PostgreSQL compatibility suite.

## What Litegres provides

- PostgreSQL 18 engine compiled to WebAssembly (PGlite 0.5.4).
- The standard PostgreSQL wire protocol per database (official
  `@electric-sql/pglite-socket` server), so any PostgreSQL client works:
  psql, JDBC, node-postgres, postgres.js, Diesel, sqlx, pgx, asyncpg,
  ActiveRecord, and migration tools (Flyway, Liquibase, Prisma, Alembic).
- Real features verified by the test suite: transactions, savepoints,
  `ROLLBACK TO`, `RETURNING`, JSONB, arrays, enums, foreign keys, unique
  constraints, `ON CONFLICT`, prepared-statement parameters.
- One database per port; multiple concurrent connections per database are
  serialized at the query level (see below).

## What Litegres is not

Do **not** use Litegres to validate:

| Area | Why |
|---|---|
| Realistic concurrent PostgreSQL sessions | PGlite is single-process; connections share one query queue. Concurrency semantics differ from a real server. |
| Deadlocks / lock contention | The WASM build runs one transaction at a time; lock graphs are not representative. |
| Connection-pool exhaustion | `maxConnections` on the socket server is a queue, not an OS process limit. |
| Replication / failover / HA | Not supported. |
| WAL behavior | PGlite's WAL is for its own persistence story, not PostgreSQL's. |
| SSL behavior | The socket server answers SSL requests with "no SSL". `sslmode=disable` in JDBC is the supported mode. |
| Arbitrary PostgreSQL extensions | Only extensions bundled with PGlite; no `CREATE EXTENSION` of arbitrary binaries. |
| Native PostgreSQL performance | WASM execution, in-process queueing, in-memory storage — numbers are not comparable. |
| OS integration | No roles, no pg_hba beyond trust, no systemd, no PostGIS-on-the-host. |
| Production deployment correctness | It is a test fixture, not a server. |

Also note:

- **Auth is `trust`-based**: PGlite authenticates local connections without
  enforcing passwords. Client libraries accept the generated password, but it
  is not cryptographically verified by the engine.
- **Cancellation**: `CancelRequest` messages are consumed and dropped.
- **Sequential execution**: multiple connections share one PGlite instance;
  the socket server queues queries. A long transaction on one connection
  blocks queries from others.

## Recommended two-layer strategy

```text
Fast test suite:      Litegres on every local run and pull request.
Compatibility suite:  Native PostgreSQL through Testcontainers or CI infra.
```

- Use Litegres for the majority of tests that just need "a real, isolated,
  PostgreSQL-compatible database".
- Keep a smaller suite on native PostgreSQL for the areas above: concurrency,
  locking, WAL, SSL, extensions, performance.

## Verified by the automated suite

`test/integration/sql-features.test.ts` exercises, over the wire protocol:
transactions, rollback, savepoints, `RETURNING`, JSONB, arrays, enums,
foreign keys, unique constraints, `ON CONFLICT`, parameterized queries, and
multi-query sessions. `test/integration/isolation.test.ts` verifies
cross-database isolation. `test/process/process.test.ts` verifies the
compiled daemon end to end.
