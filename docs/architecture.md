# Litegres architecture

## Overview

Litegres is a long-lived local daemon (`litegresd`) that manages many
isolated databases on **one real PostgreSQL server**. It exposes two planes:

1. **Control plane** — an HTTP API on `127.0.0.1:49100` for creating,
   cloning, resetting, inspecting, leasing and destroying sessions,
   templates and databases.
2. **Data plane** — the PostgreSQL server itself; each database has its own
   name on the server's port and speaks the standard wire protocol.

The control plane never carries SQL; normal application queries go straight
to PostgreSQL over the wire protocol.

## Process model

```
┌──────────────────────────────────────────────────────────┐
│ litegresd (one Bun process)                              │
│                                                          │
│  control API (Bun.serve)                                 │
│      │                                                   │
│  registries: databases · templates · sessions            │
│      │                                                   │
│  reaper (lease expiry) ← injectable clock                │
│      │                                                   │
│  NativeEngine ── CREATE / DROP DATABASE ──┐              │
└───────────────────────────────────────────┼──────────────┘
                                            ▼
                     ┌──────────────────────────────────┐
                     │ PostgreSQL server                │
                     │  templates · databases           │
                     └──────────────────────────────────┘
```

- **One server, many databases.** A database is a `CREATE DATABASE`, a
  template is a sealed database, a clone is `CREATE DATABASE ... TEMPLATE`.
  Memory is one server plus a little per connection.
- **Ownership.** `NativeEngine` is the only place that talks to the server's
  catalog. `ManagedDatabase` owns an `EngineDatabase` handle; the API layer
  only ever sees descriptors and connection strings. See
  [postgres.md](postgres.md) for crash recovery and multiple daemons.

## Control plane

- `ApiServer` (Bun.serve) routes requests, assigns request IDs, enforces
  auth, and serializes structured errors.
- `AuthManager` validates the daemon bearer token or session lease tokens.
- Registries are plain in-memory maps with capacity accounting and
  explicit lifecycle state machines (no boolean soup).

## Sessions, leases and the reaper

- A **session** represents one client process or test run and owns databases.
- Every database and session carries an absolute expiry timestamp.
- The **reaper** runs on a configurable interval (default 10 s) and:
  - closes databases whose leases ended,
  - expires sessions whose leases ended and destroys their databases,
  - reaps failed/closed templates (ready templates are retained),
  - never closes an instance twice (close is idempotent),
  - continues when an individual cleanup fails, recording failures in
    diagnostics.

Elapsed-duration decisions use monotonic time where possible; lease expiry
uses wall-clock timestamps expressed in UTC ISO 8601. The clock is
injectable for tests.

## Templates

A template is an immutable, prepared database:

- `PUT /v1/templates/{fingerprint}` creates a database, applies the
  initialization statements and seals it (idempotent by fingerprint).
- `POST /v1/templates` starts **provisioning**: an empty database returned
  to the client so Flyway/Liquibase/Prisma/etc. can run migrations with their
  own tooling. `POST /v1/templates/{id}/finalize` verifies readiness over the
  wire, disconnects everyone, forbids new connections (`ALLOW_CONNECTIONS
  false`) and marks the template immutable.
- Clones are `CREATE DATABASE ... TEMPLATE <template>`; a **reset**
  (`POST /v1/databases/{id}/reset`) drops and recreates a database from its
  template under the same name.

## Shutdown

On `SIGINT`/`SIGTERM` (or `POST /v1/shutdown`):

1. state → `DRAINING`; new creations rejected; health/ready returns 503
2. reaper stops
3. sessions close (destroying their databases)
4. remaining databases close
5. templates close
6. control API stops
7. discovery/token/lock files are removed
8. state → `STOPPED`; process exits 0

Shutdown is idempotent and bounded by `shutdownTimeoutMs`; individual close
failures are logged and do not stop the rest.

## Resource limits

`maxDatabases`, `maxTemplates`, `maxDatabasesPerSession` are enforced at
creation time (counting in-flight creations, so concurrent bursts cannot
overshoot). Exhaustion returns `429 DATABASE_CAPACITY_EXHAUSTED`.

## Capacity

Every database costs a server-side `CREATE DATABASE` (~15 ms from a small
template) and a few MiB; the limits are `maxDatabases` and the server's own
`max_connections` and CPU. Parallel test workers run as real, concurrent
backends.

## Dependencies

- `pg` — admin connections to the server (create/drop/seal databases, exec,
  readiness checks)
- a PostgreSQL 13+ server (yours, or a throwaway container the daemon starts)
- no Node.js compatibility layer
