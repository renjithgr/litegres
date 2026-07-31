import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { parseConfig } from './config'
import { sendControlMessage } from './protocol'

function log(message: string): void {
  process.stderr.write(`[litegres-runtime] ${message}\n`)
}

async function readPgliteVersion(): Promise<string> {
  try {
    // Not part of @electric-sql/pglite's public "exports" map, so TS cannot
    // resolve types for this subpath even though Bun loads it fine at runtime.
    // @ts-expect-error -- see comment above
    const pkg = (await import('@electric-sql/pglite/package.json', {
      with: { type: 'json' },
    })) as { default: { version: string } }
    return pkg.default.version
  } catch {
    return 'unknown'
  }
}

let db: PGlite | undefined
let server: PGLiteSocketServer | undefined
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log(`already shutting down, ignoring additional ${signal}`)
    return
  }
  shuttingDown = true
  log(`received ${signal}, shutting down`)

  try {
    await server?.stop()
  } catch (err) {
    log(`error stopping socket server: ${(err as Error).message}`)
  }

  try {
    await db?.close()
  } catch (err) {
    log(`error closing PGlite: ${(err as Error).message}`)
  }

  log('shutdown complete')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

function reportFatal(err: Error): void {
  log(`fatal error: ${err.stack ?? err.message}`)
  sendControlMessage({ type: 'error', message: err.message, stack: err.stack })
  process.exit(1)
}

process.on('uncaughtException', (err) => reportFatal(err))
process.on('unhandledRejection', (reason) => {
  reportFatal(reason instanceof Error ? reason : new Error(String(reason)))
})

interface ListeningDetail {
  port?: number
  host?: string
  path?: string
}

/**
 * PGlite normally resolves pglite.wasm / pglite.data / initdb.wasm relative to
 * its own module URL. That resolution breaks inside a `bun build --compile`
 * standalone executable, whose virtual filesystem cannot serve sibling asset
 * files by path. When assetsDir is supplied we read the three asset files
 * from disk ourselves and hand them to PGlite directly, bypassing its
 * relative-URL loading entirely.
 */
async function loadExplicitAssets(
  assetsDir: string,
): Promise<Pick<PGliteOptions, 'pgliteWasmModule' | 'initdbWasmModule' | 'fsBundle'>> {
  log(`loading PGlite assets explicitly from ${assetsDir}`)
  const [pgliteWasmBytes, initdbWasmBytes, fsBundleBytes] = await Promise.all([
    readFile(path.join(assetsDir, 'pglite.wasm')),
    readFile(path.join(assetsDir, 'initdb.wasm')),
    readFile(path.join(assetsDir, 'pglite.data')),
  ])
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(pgliteWasmBytes),
    WebAssembly.compile(initdbWasmBytes),
  ])
  return {
    pgliteWasmModule,
    initdbWasmModule,
    fsBundle: new Blob([new Uint8Array(fsBundleBytes)]),
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv)
  log(
    `starting: database="${config.database}" dataDir="${config.dataDir ?? '(in-memory)'}" requestedPort=${config.port}`,
  )

  const explicitAssets = config.assetsDir ? await loadExplicitAssets(config.assetsDir) : {}

  // NOTE: PGlite's `database`/`username` PGliteOptions only work when they
  // name a role/database that initdb already bootstrapped (i.e. the built-in
  // "postgres"/"postgres") — passing any other value crashes initialization
  // ("FATAL: database ... does not exist"). Separately, PGlite's socket layer
  // ignores the database/user named in a client's wire-protocol StartupMessage
  // entirely: every connection lands on the same internal postgres/postgres
  // session regardless of what the JDBC URL says. So we never forward
  // config.database/config.username into PGlite itself — they only affect the
  // reported ready message (host/port/database/username), which the JVM side
  // uses to build a JDBC URL that happens to work with any db/user string.
  const pgliteOptions: PGliteOptions = {
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...explicitAssets,
  }
  // NOTE: PGlite.create(dataDir, options) silently discards `options` whenever
  // `dataDir` is not a string (e.g. undefined for the in-memory default) — see
  // PGlite.create()'s overload resolution in pglite.ts. dataDir must therefore
  // travel inside the single options object, never as a separate argument.
  db = await PGlite.create(pgliteOptions)
  log('PGlite instance ready')

  let boundPort: number | undefined
  server = new PGLiteSocketServer({
    db,
    port: config.port,
    host: config.host,
    // PGlite itself only executes one query at a time (PGLiteSocketServer's
    // own QueryQueueManager serializes them), but capping *socket* connections
    // at 1 (the pglite-socket default) rejects a new connection with "Too many
    // connections" if the previous one hasn't finished its async TCP teardown
    // yet — a real race we hit running sequential JDBC connections (e.g. our
    // own readiness check immediately followed by a Flyway migration).
    // Allowing several concurrent sockets avoids that without changing how
    // queries are actually serialized.
    maxConnections: 10,
  })

  server.addEventListener('listening', (event) => {
    const detail = (event as CustomEvent<ListeningDetail>).detail
    boundPort = detail.port
    log(`socket server listening on ${config.host}:${detail.port}`)
  })

  server.addEventListener('error', (event) => {
    const error = (event as CustomEvent<Error>).detail
    log(`socket server error: ${error?.message ?? String(error)}`)
  })

  await server.start()

  if (boundPort === undefined) {
    throw new Error('PGLiteSocketServer did not report a bound TCP port after start()')
  }

  const versionResult = await db.query<{ version: string }>('select version()')
  const postgresVersion = versionResult.rows[0]?.version ?? 'unknown'
  const pgliteVersion = await readPgliteVersion()

  sendControlMessage({
    type: 'ready',
    host: config.host,
    port: boundPort,
    database: config.database,
    username: config.username,
    password: config.password,
    pgliteVersion,
    postgresVersion,
  })
  log('ready message sent, awaiting connections')
}

main().catch((err) => reportFatal(err instanceof Error ? err : new Error(String(err))))
