# Contributing to Litegres

Thanks for contributing! Litegres is a small, focused daemon; keep it that
way.

## Prerequisites

- [Bun](https://bun.sh) 1.3+ (Bun is the runtime, package manager, test
  runner, and bundler — no Node.js toolchain, no Docker required).

## Setup

```bash
bun install
```

## Development loop

```bash
bun run typecheck          # strict TypeScript, no emit
bun run lint               # typecheck + hygiene checks
bun run dev                # run the daemon in the foreground (dev mode)
bun test                   # everything: unit + integration + compatibility
bun run integration-test   # integration only
bun run process-test       # compiled binary, clean directory
bun run build              # dist/litegresd standalone executable
bun run benchmark          # timing numbers (machine-specific)
```

Process tests build the executable if `dist/litegresd` is missing; you can
point them at a prebuilt binary with `LITEGRES_BIN=/path/to/litegresd`.

## Repository layout

```text
src/               daemon core (config, api, registries, databases, templates,
                   sessions, lifecycle, security, observability, cli)
clients/typescript first-party TypeScript control-plane client
test/unit          pure unit tests (no daemon)
test/integration   real daemons + a real PostgreSQL server + real pg clients
test/process       compiled binary lifecycle from a clean temp dir
test/compatibility OpenAPI validity + client behavior
scripts/           build, package, benchmark, lint, openapi generation
examples/          runnable examples
docs/              architecture, control API, lifecycle, security, compatibility
```

## Conventions

- **Strict TypeScript.** `strict: true` plus `noUncheckedIndexedAccess`.
- **Structured logging.** Use the `Logger`; never `console.log` in daemon
  code (the CLI surface is the exception). Secrets are redacted
  automatically — never log passwords or tokens.
- **Explicit lifecycle states.** New resources use the state machines in
  `src/lifecycle/state-machine.ts`. No boolean flags for lifecycle.
- **Cleanup is idempotent.** Closing, deleting, and destroying must be safe
  to repeat.
- **Verify behavior against a real server.** PostgreSQL semantics (locking,
  `CREATE DATABASE ... TEMPLATE` rules, `pg_stat_activity`) are subtle; check
  them with a real server rather than from memory.
- **No premature abstractions.** One PostgreSQL server, one daemon process.
  Keep ownership clear (`ManagedDatabase` owns one engine handle) so that can
  change later; do not build for it now.

## Testing

- Every feature needs a test that exercises a **real** path: a real daemon,
  a real PostgreSQL server, and a real PostgreSQL client over the wire.
  Mocks are acceptable only for seams the spec names (clock, logger).
- Reaper tests use the `ManualClock`; never sleep to test expiry.
- Process tests spawn the compiled binary from a clean temporary directory.

## Docs

User-facing changes should update the README and the relevant `docs/*.md`.
The OpenAPI document lives in `src/api/openapi.ts`; regenerate
`docs/openapi.yaml` with:

```bash
bun run scripts/generate-openapi.ts
```

`bun run lint` verifies the YAML is in sync.

## Submitting changes

1. Run `bun run lint` and `bun test` locally.
2. Run `bun run process-test` if the daemon/CLI/packaging changed.
3. Open a PR with a focused description; note any behavior changes in the
   README/docs.

## License

Apache-2.0. By contributing you agree to license your work under it.
