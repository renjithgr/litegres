# Litegres control API

Versioned, localhost-only HTTP API. The OpenAPI 3.1 document is
[`openapi.yaml`](openapi.yaml) (generated from
`src/api/openapi.ts`; validate with `bun test test/compatibility`).

Base URL: `http://127.0.0.1:49100` (configurable).

## Authentication

All `/v1` mutations require either:

- `Authorization: Bearer <daemon-token>` — full control (token in the
  runtime dir `token` file), or
- `X-Litegres-Lease-Token: <session-lease-token>` — scoped to the session
  that owns the resource.

Health endpoints are unauthenticated. Errors use this shape:

```json
{
  "error": {
    "code": "DATABASE_NOT_FOUND",
    "message": "Database db_01K2ABC was not found.",
    "requestId": "req_01K2XYZ",
    "details": {}
  }
}
```

## Endpoints

### Health & status

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health/live` | none | process + HTTP server alive |
| GET | `/health/ready` | none | can accept database creation (`200`) or draining (`503`) |
| GET | `/v1/status` | none | daemon status (no secrets) |
| GET | `/v1/metrics` | none | internal counters/gauges/timings |
| GET | `/v1/openapi.json` | none | the OpenAPI document |

### Sessions

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/sessions` | daemon | create; returns `leaseToken` once |
| GET | `/v1/sessions` | daemon | list (no lease tokens) |
| GET | `/v1/sessions/{id}` | daemon/lease | get |
| POST | `/v1/sessions/{id}/renew` | daemon/lease | renew lease `{"ttlSeconds": 1800}` |
| DELETE | `/v1/sessions/{id}` | daemon/lease | close + destroy owned databases (idempotent, 204) |

### Databases

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/databases` | daemon/lease | create empty or clone template; returns credentials once (201) |
| GET | `/v1/databases` | daemon | list; filters: `sessionId`, `templateId`, `state`, `expired`, `application` |
| GET | `/v1/databases/{id}` | daemon/lease | get (no credentials) |
| POST | `/v1/databases/{id}/renew` | daemon/lease | renew lease |
| DELETE | `/v1/databases/{id}` | daemon/lease | destroy (idempotent, 204) |
| POST | `/v1/databases/{id}/exec` | daemon/lease | admin SQL (diagnostics/provisioning only) |

`POST /v1/databases` request:

```json
{
  "sessionId": "ses_01K2ABCDEF",
  "templateId": "tpl_01K2ABC",
  "storage": { "type": "memory" },
  "ttlSeconds": 600,
  "metadata": { "testClass": "AccountRepositoryTest" },
  "initialization": {
    "statements": ["CREATE TABLE accounts (id bigint primary key, name text not null)"]
  }
}
```

`templateId` and `initialization` are mutually exclusive. A database is only
reported `ready` after a real PostgreSQL client passed a readiness check
against its wire endpoint.

### Templates

| Method | Path | Auth | Description |
|---|---|---|---|
| PUT | `/v1/templates/{fingerprint}` | daemon | create from statements; idempotent by fingerprint |
| POST | `/v1/templates` | daemon | start external provisioning; returns `provisioningDatabase` once |
| GET | `/v1/templates` | daemon | list |
| GET | `/v1/templates/{id}` | daemon | get |
| POST | `/v1/templates/{id}/finalize` | daemon | verify, snapshot, close endpoint, mark immutable |
| DELETE | `/v1/templates/{id}` | daemon | destroy (idempotent, 204) |

### Daemon control

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/gc` | daemon | run one reaper pass |
| POST | `/v1/shutdown` | daemon | graceful shutdown (response flushes first) |

## Error codes

`UNAUTHORIZED`, `INVALID_REQUEST`, `INVALID_CONFIGURATION`,
`SESSION_NOT_FOUND`, `SESSION_EXPIRED`, `DATABASE_NOT_FOUND`,
`DATABASE_NOT_READY`, `DATABASE_CAPACITY_EXHAUSTED`, `TEMPLATE_NOT_FOUND`,
`TEMPLATE_NOT_READY`, `TEMPLATE_CAPACITY_EXHAUSTED`,
`INVALID_STATE_TRANSITION`, `DATABASE_CREATION_FAILED`,
`TEMPLATE_CREATION_FAILED`, `DATABASE_CLEANUP_FAILED`,
`PGLITE_STARTUP_FAILED`, `SOCKET_SERVER_STARTUP_FAILED`,
`READINESS_CHECK_FAILED`, `DAEMON_ALREADY_RUNNING`, `DAEMON_NOT_READY`,
`INTERNAL_ERROR`, `PAYLOAD_TOO_LARGE`, `EXEC_FAILED`, `EXEC_TIMEOUT`,
`EXEC_ROW_LIMIT`.

## Limits

- Request body: 1 MiB
- Initialization: 100 statements, 1 MiB total
- `exec`: 1 MiB SQL, 1000 rows, 5 s timeout
- Database TTL: default 600 s, max 3600 s
- Session TTL: default 1800 s, max 14400 s
