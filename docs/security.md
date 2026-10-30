# Security model

Litegres is a **local development and testing service**. It is not a secure
multi-tenant hosting platform, and it is not exposed over a public network by
default.

## Binding

- Control API: `127.0.0.1` (default). Non-loopback hosts (`0.0.0.0`, LAN
  addresses) are rejected at startup unless
  `LITEGRES_REJECT_NON_LOCAL_BIND=false` is explicitly set.
- Data plane: the PostgreSQL server's own address (the managed container binds a random loopback port).

## Authentication

Two credential kinds:

1. **Daemon control token** — generated at startup (or from
   `LITEGRES_CONTROL_TOKEN`), stored in the runtime dir `token` file
   (`chmod 600`). Sent as `Authorization: Bearer <token>`. Grants full
   control: sessions, databases, templates, gc, shutdown.
2. **Session lease token** — generated per session, returned exactly once in
   the session creation response. Sent as `X-Litegres-Lease-Token: <token>`.
   Scoped: a lease token can only manage databases it owns and its own
   session. It cannot create or manage templates, list everything, or shut
   the daemon down.

Rules enforced by `AuthManager`:

- every `/v1` mutation requires one of the two,
- session mutation requires the daemon token or that session's lease token,
- database operations require the daemon token or the owning session's lease
  token,
- health endpoints are unauthenticated (localhost only),
- comparisons are timing-safe.

## Secrets handling

- Database passwords are generated per database (32 bytes of entropy) and
  returned **only** in the creation response.
- List/get endpoints never include passwords, tokens, or connection URLs.
- Logs redact passwords, tokens, and credential-bearing URLs.
- The `exec` endpoint is authenticated and rate/size/timeout-limited; it is
  not the normal data path.

> Note on database credentials: clients receive the **PostgreSQL server's own
> admin credentials**, not a per-database login. Litegres is a test fixture:
> point it only at a disposable server (the managed container uses a fixed
> test password and a loopback-only port). See `docs/postgres.md`.

## Runtime directory

```text
$XDG_RUNTIME_DIR/litegres/           (or ~/.local/state/litegres on macOS,
                                      or $LITEGRES_RUNTIME_DIR)
├── daemon.json    discovery file (pid, controlUrl, tokenFile, startedAt)  chmod 600
├── token          daemon control token                                    chmod 600
└── lock/pid       single-daemon lock (atomic mkdir)                       chmod 700
```

- Files are written atomically (temp file + rename) with restrictive modes.
- The lock prevents two daemons from claiming the same runtime directory:
  a live owner → `DAEMON_ALREADY_RUNNING`; a dead owner → stale takeover.
- On shutdown the discovery, token, and lock files are removed.

## Threat model (honest)

A local attacker who can read the `token` file (same user) can control the
daemon — that is the intended trust boundary. The daemon does **not**
protect against:

- other local users with read access to your home/runtime directory
  (file modes help; they are not a substitute for OS-level sandboxing),
- malicious SQL from clients that already hold a valid lease token,
- network attacks if you deliberately bind to a non-loopback address.
