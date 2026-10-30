> **Historical.** This is the Phase 0 evidence that led Litegres to drop its
> in-process WebAssembly engine ("Litegres" below) and use real PostgreSQL
> only. The workarounds named here (`prepareThreshold=0`, Flyway lock
> settings) are no longer needed or supported.

# Phase 0 results: Litegres (PGlite/WASM) vs native Postgres 17 + CREATE DATABASE ... TEMPLATE

Machine: Apple Silicon, 14 cores, 48 GiB, OrbStack. Native = `postgres:17-alpine` container, default settings.
Reproduce: `./reset.sh`, `./gradlew bench -Pbackend={template|litegres}`, `./run-suite.sh {template|litegres} <forks>`.

## Microbenchmarks (raw JDBC)
| metric | native + TEMPLATE | Litegres |
|---|---|---|
| clone/create p50 | 17 ms | 72 ms |
| 16 clones in parallel (wall) | 186 ms | 1777 ms |
| workload on 1 DB | 295 ms | 771 ms |
| same workload on 8 DBs at once | 630 ms (2.1x) | 4413 ms (5.7x, near-serial) |
| memory, 16 live used DBs | 147 MiB | 3607 MiB RSS |

## Spring Boot suite (12 context-per-class CRUD classes + 6 behavior classes = 48 tests)
| | native | Litegres |
|---|---|---|
| pass / fail | 48 / 0 | 17 / 31 |
| wall, 1 fork | 20 s | 63 s (with hangs/timeouts) |
| wall, 4 forks | 11 s | 66 s (no speedup) |

## Findings on Litegres
1. Flyway hangs by default (cross-connection deadlock). Needed `flyway.postgresql.transactional.lock=false`.
2. pgjdbc default server-side prepared statements collide across connections (`prepared statement "S_1" already exists`). Needed `prepareThreshold=0`.
3. One connection with an open transaction blocks every other connection (SKIP LOCKED worker B waited 2.2 s vs 5-19 ms native; all two-connection probes timed out).
4. No extensions available (pgcrypto, uuid-ossp, pg_trgm, citext, hstore, btree_gist, unaccent, vector, postgis); LISTEN/NOTIFY not delivered.
5. JPA save and a jsonb/array JdbcTemplate query fail with "Connection is closed" / "No results were returned". Reproduces with pool size 1 and without workaround 2. Root cause NOT identified.
6. Short, serialized concurrent transactions (8 threads x 100 transfers) do pass.
