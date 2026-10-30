# Litegres architecture

## Overview

Litegres is a long-lived local daemon (`litegresd`) that hosts many isolated
PGlite database instances inside one Bun process. It exposes two planes:

1. **Control plane** — an HTTP API on `127.0.0.1:49100` for creating,
   cloning, inspecting, leasing and destroying sessions, templates and
   databases.
2. **Data plane** — one TCP port per database speaking the standard
   PostgreSQL wire protocol.

The control plane never carries SQL; normal application queries go over the
wire protocol to PGlite's socket server.

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
│  DatabaseFactory ── creates ──► PGlite instance          │
│      │                            └─ PGLiteSocketServer  │
│      │                               (port 0 → OS port)  │
│      └── TemplateRegistry ── snapshot tarball ──► clones │
└──────────────────────────────────────────────────────────┘
```

- **One process, many PGlite instances.** PGlite's WASM module is shared
  (compiled once); each instance has its own PGDATA and linear memory. This
  is the fundamental trade-off: speed and simplicity at the cost of memory.
- **Port per database.** Each database binds a `PGLiteSocketServer` to
  `127.0.0.1:0`; the OS assigns an ephemeral port, which the daemon reports.
  No port is reserved by opening/closing a temporary socket.
- **Ownership.** The `DatabaseFactory` is the only place that constructs
  PGlite instances and socket servers. `ManagedDatabase` owns one instance +
  one server; the API layer only ever sees descriptors and connection
  strings. Mutable PGlite objects never leave the database-management layer.

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

A template is an immutable snapshot (a `dumpDataDir("none")` tarball) of a
prepared PGlite instance:

- `PUT /v1/templates/{fingerprint}` applies initialization statements and
  snapshots the result (idempotent by fingerprint).
- `POST /v1/templates` starts **provisioning**: a live instance with an
  ephemeral PostgreSQL endpoint so Flyway/Liquibase/Prisma/etc. can run
  migrations with their own tooling. `POST /v1/templates/{id}/finalize`
  verifies readiness over the wire, snapshots, closes the endpoint, and marks
  the template immutable.
- Clones are `PGlite.create({ loadDataDir: snapshot })` — the official
  PGlite clone mechanism (the same one `clone()` uses internally).

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

## Engines

The control plane talks to an `Engine` (`src/engine/engine.ts`) and only ever
holds opaque handles: `EngineDatabase`, `TemplateData`, `ProvisioningHandle`.
`NativeEngine` hosts databases on one PostgreSQL server
(`CREATE DATABASE ... TEMPLATE`), `PgliteEngine` hosts one WASM instance per
database. See [engines.md](engines.md). Everything below about "one process,
many PGlite instances" and memory describes the PGlite engine only.

## Memory constraints (PGlite engine)

Each PGlite instance allocates a WASM linear memory (default initial size
128 MiB per instance, growing on demand). With default settings this is the
dominant resource. Measured on the reference machine, RSS is roughly
300–400 MiB per *active* instance after use, plus shared baseline. Guidance:

- keep `maxDatabases` small enough for the machine,
- prefer cloning prepared templates (no initdb cost, ~100 ms) over creating
  empty databases (~400–500 ms) when many instances are needed,
- delete databases as soon as tests finish; the reaper handles leaks.

## Future: worker sharding

A later milestone may shard instances across worker processes:

```
main process
├── control API
├── registry and scheduler
└── workers
    ├── worker 1 owns databases A–D
    ├── worker 2 owns databases E–H
    └── worker 3 owns databases I–L
```

Resource ownership is already structured so this is possible: `ManagedDatabase`
is the unit of ownership, factories construct instances, and the registries
never expose PGlite objects. The MVP deliberately avoids premature worker
abstractions; the single-process implementation must be stable first.

## Future: shared-port routing

A custom shared-port PostgreSQL router (one port, virtual database routing)
is explicitly a non-goal for the MVP. The port-per-database model is simpler
and uses the official socket server unmodified.

## Dependencies

- `@electric-sql/pglite` (0.5.4) — the WASM Postgres engine
- `@electric-sql/pglite-socket` (0.2.7) — the official socket server
- `pg` — used only for daemon-side readiness checks and diagnostics
- no Node.js compatibility layer, no Docker
