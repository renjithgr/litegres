# Standalone packaging and implementation notes

## Bun standalone executable

`bun run build` produces `dist/litegresd` via `Bun.build({ compile: true })`
(see `scripts/build.ts`).

### How PGlite assets work

PGlite normally loads `pglite.wasm`, `initdb.wasm` and `pglite.data` from
disk relative to its module URL. In a compiled executable `node_modules`
does not exist, so the daemon:

1. imports the three artifacts with `{ type: "file" }` from the pglite
   package (`src/packaging/pglite-assets.ts`);
2. in a compiled binary Bun embeds those assets into the executable's
   `$bunfs` virtual filesystem and the import resolves to a `/$bunfs/...`
   URL;
3. at runtime `Bun.file(url)` returns the bytes regardless of whether the
   URL is a real path (source mode) or a virtual one (compiled mode);
4. the bytes are handed to `PGlite.create({ pgliteWasmModule,
   initdbWasmModule, fsBundle })`, which bypasses PGlite's own disk reads.

This single code path works both from source and from the compiled binary,
and the binary is self-contained: copying it to a clean directory and
running it works (verified by `test/process/process.test.ts`).

### Known packaging details

- **Size**: the executable is ~72 MiB (macOS arm64) — the WASM artifacts
  (`pglite.data` alone is ~13 MiB, plus `pglite.wasm` and `initdb.wasm`)
  are embedded uncompressed. Minified JS is a small fraction.
- **Version reporting**: `PGLITE_VERSION` is baked in via a Bun `--define`
  of the plain identifier `__PGLITE_VERSION__`. (Bun's define does **not**
  match `import.meta.env.X` member expressions — a plain identifier is
  required.) Source mode falls back to probing `node_modules`.
- **Compile output naming**: the `Bun.build` JS API writes the executable
  into `outdir` named after the entrypoint (not `outfile`); `scripts/build.ts`
  renames it to `litegresd`.
- **Platform**: the host platform only (darwin-arm64 in this repo's
  development environment; CI builds Linux x86-64). Cross-compilation is not
  supported by `bun build --compile`.
- **Extensions**: PGlite's optional extension tarballs (`*.tar.gz`) are not
  embedded; the MVP ships without `extensions`. Enabling them in a compiled
  binary would require embedding those assets too.

## Technical assumptions that required adaptation

- **PGlite asset loading in standalone builds** — assumed `--compile` would
  handle everything; it does not. Adapted with explicit module/fsBundle
  injection (above). This is the single largest packaging risk and is now
  verified by process-level tests.
- **Status field casing** — the lifecycle state machine uses uppercase state
  names (`READY`); API responses serialize them lowercase (`ready`) to match
  the documented API shape.
- **Socket server port 0** — `PGLiteSocketServer` supports `port: 0` and
  reports the assigned port through `getServerConn()` after `start()`. No
  port reservation dance is needed.
- **Template cloning** — `ManagedTemplate.clone()` is implemented as
  `dumpDataDir("none")` + `PGlite.create({ loadDataDir })` (the same
  mechanism PGlite's `clone()` uses). Templates keep only the snapshot
  tarball after finalize; the provisioning instance is closed.
- **Daemon shutdown vs in-flight control requests** — `server.stop(true)`
  terminates in-flight connections, so `POST /v1/shutdown` defers the actual
  shutdown ~150 ms to let its own response flush; the CLI tolerates a
  connection reset during shutdown.
- **Capacity under concurrency** — capacity checks count in-flight
  creations so parallel bursts cannot overshoot the configured limit.
- **`import.meta.env` defines** — Bun's define does not match
  `import.meta.env.X`; plain identifiers are used.
- **pg package layout** — `pg` exports from `lib/index.js`; nothing special
  needed, it works in Bun and in compiled binaries.

## Known PGlite compatibility limitations

See `docs/compatibility.md` for the full list. Highlights:

- one database is a single WASM instance; multiple connections are
  serialized at the query level;
- `trust` authentication (passwords are generated but not enforced);
- SSL requests are answered with "no SSL";
- cancellation requests are dropped;
- only bundled extensions (none enabled in the MVP);
- not a substitute for native PostgreSQL in concurrency, WAL, replication,
  performance, or production-correctness scenarios.

## Work deferred beyond the MVP

- worker sharding (ownership is designed for it; see `docs/architecture.md`)
- shared-port PostgreSQL router
- Prometheus endpoint (metrics abstraction exists; JSON exposure only)
- native clients/extensions for Rust/Go/Python/Ruby (the JVM client and
  JUnit 5 extension are implemented in `jvm/`; Spring Boot wiring is
  demonstrated by `LitegresDataSourceTest`)
- cross-platform CI matrix beyond Linux x86-64
- background-mode hardening (available via `start --background`; foreground
  is the supported MVP mode)
- parameterized `exec` beyond PGlite's native parameter binding
- template garbage collection beyond failed/closed reaping
