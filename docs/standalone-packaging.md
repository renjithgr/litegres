# Standalone packaging

## Bun standalone executable

`bun run build` produces `dist/litegresd` via `Bun.build({ compile: true })`
(see `scripts/build.ts`). The result is a single self-contained executable:
copy it to a clean directory and run it (`test/process/process.test.ts`
verifies exactly that).

- **Size**: ~60 MiB, almost all of it the Bun runtime itself.
- **Compile output naming**: the `Bun.build` JS API writes the executable into
  `outdir` named after the entrypoint (not `outfile`); `scripts/build.ts`
  renames it to `litegresd`.
- **Platform**: the host platform only (CI builds Linux x86-64). Cross
  compilation is not supported by `bun build --compile`.
- **Runtime requirement**: a PostgreSQL 13+ server (`--postgres-url`) or
  Docker, so the daemon can start a throwaway container. See
  [postgres.md](postgres.md).

## Container image

The `Dockerfile` builds the binary in an `oven/bun` stage and ships it next
to PostgreSQL 17 (`docker/entrypoint.sh` supervises both). See the header of
the Dockerfile for the ports and environment.

## Implementation notes

- **Daemon shutdown vs in-flight control requests** — `server.stop(true)`
  terminates in-flight connections, so `POST /v1/shutdown` defers the actual
  shutdown ~150 ms to let its own response flush; the CLI tolerates a
  connection reset during shutdown.
- **Capacity under concurrency** — capacity checks count in-flight creations
  so parallel bursts cannot overshoot the configured limit.
- **Background start** — `litegresd start --background` waits (up to 90 s,
  the first start may pull a postgres image) for a discovery file written by
  the process it spawned, and fails fast with the daemon's own error if that
  process exits.
- **pg package layout** — `pg` exports from `lib/index.js`; nothing special
  needed, it works in Bun and in compiled binaries.
