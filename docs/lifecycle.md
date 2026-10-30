# Lifecycle model

All long-lived resources use explicit state machines with fixed transition
tables. There are no loosely related booleans, and invalid transitions are
rejected with `INVALID_STATE_TRANSITION` (409). Same-state transitions are
allowed for idempotency.

## Daemon

```text
STARTING → READY → DRAINING → STOPPING → STOPPED
   │         │         │          │
   └─────────┴─────────┴──────→ FAILED → STOPPED
```

- `STARTING` — acquiring the runtime lock, starting the control API.
- `READY` — accepting creation requests.
- `DRAINING` — shutdown began; creations rejected; `/health/ready` → 503.
- `STOPPING` — resources closed; stopping the control API; removing files.
- `STOPPED` — clean exit.
- `FAILED` — startup failure.

## Database

```text
CREATING → INITIALIZING → READY → CLOSING → CLOSED
   │            │           │        │
   └────────────┴───────────┼────────┘
                            └──→ FAILED → CLOSED
                                  (also READY → EXPIRED → CLOSING → CLOSED)
```

- `CREATING` — `CREATE DATABASE` in progress.
- `INITIALIZING` — initialization statements being applied.
- `READY` — wire endpoint verified by an external client; usable.
- `CLOSING` → `CLOSED` — database dropped, deregistered.
- `EXPIRED` — the reaper closed a lease that ended.
- `FAILED` — creation failed; partial resources cleaned up.

Creation is transactional: if any step fails, every partially created
resource (the partially created database) is dropped before the error returns.

## Template

```text
CREATING → PROVISIONING → INITIALIZING → READY (immutable)
   │            │              │
   └────────────┴──────────────┴──────→ CLOSING → CLOSED
                                        FAILED → CLOSED
```

- `CREATING` — instance booting.
- `PROVISIONING` — live PostgreSQL endpoint for external migration tooling.
- `INITIALIZING` — finalize: readiness check + snapshot in progress.
- `READY` — snapshot stored, endpoint closed, immutable, cloneable.
- `CLOSING`/`CLOSED` — destroyed.
- `FAILED` — provisioning/finalization failed; reaper removes it.

## Session

```text
ACTIVE → CLOSING → CLOSED
   │        │
   └────────┴──→ EXPIRED → CLOSING → CLOSED
```

- `ACTIVE` — owns databases.
- `CLOSING`/`CLOSED` — databases destroyed, session removed.
- `EXPIRED` — reaper expired the lease and destroyed its databases.

## Cleanup guarantees

- **Idempotent**: closing an already-closed resource is a no-op; deleting an
  absent database/session/template returns success (204).
- **Safe under races**: `ManagedDatabase.close()` memoizes its promise, so
  concurrent destroy calls close exactly once.
- **Failure-tolerant**: shutdown and the reaper keep going when an individual
  resource fails to close, logging the failure with a request/resource ID.

## Timestamps

- Absolute timestamps are UTC ISO 8601 (`2026-08-06T17:45:00Z`).
- Elapsed-duration decisions (timeouts, budgets) use monotonic time.
- The clock is injectable; reaper tests advance it without sleeping.
