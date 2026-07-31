/**
 * Configuration for a single launcher invocation.
 * Passed as a single JSON-encoded argv entry (argv[2]) rather than many
 * flags, so the JVM side can build the process argument list without any
 * shell-quoting concerns.
 */
export interface RuntimeConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
  dataDir?: string
  startupTimeoutMs: number
  /**
   * Directory containing pglite.wasm, pglite.data and initdb.wasm to load
   * explicitly instead of PGlite's default relative-to-module resolution.
   * Required when running as a `bun build --compile` standalone executable,
   * whose virtual filesystem cannot serve sibling asset files by path.
   */
  assetsDir?: string
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 0,
  database: 'postgres',
  username: 'postgres',
  password: 'postgres',
  startupTimeoutMs: 30_000,
} as const

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseConfig(argv: readonly string[]): RuntimeConfig {
  const raw = argv[2]
  let parsed: Record<string, unknown> = {}

  if (raw !== undefined && raw.length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new ConfigError(
        `Malformed configuration JSON passed as argv[2]: ${(err as Error).message}`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError('Configuration argv[2] must be a JSON object')
    }
  }

  const host = typeof parsed.host === 'string' ? parsed.host : DEFAULTS.host
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ConfigError(
      `Refusing to bind to host "${host}". Only ${Array.from(ALLOWED_HOSTS).join(' or ')} are permitted — the runtime must never be exposed externally.`,
    )
  }

  const port = parsed.port === undefined ? DEFAULTS.port : parsed.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid port: ${JSON.stringify(parsed.port)}. Must be an integer between 0 and 65535.`)
  }

  const database =
    typeof parsed.database === 'string' && parsed.database.length > 0
      ? parsed.database
      : DEFAULTS.database

  const username =
    typeof parsed.username === 'string' && parsed.username.length > 0
      ? parsed.username
      : DEFAULTS.username

  const password = typeof parsed.password === 'string' ? parsed.password : DEFAULTS.password

  const dataDir = typeof parsed.dataDir === 'string' ? parsed.dataDir : undefined

  const startupTimeoutMs =
    typeof parsed.startupTimeoutMs === 'number' && parsed.startupTimeoutMs > 0
      ? parsed.startupTimeoutMs
      : DEFAULTS.startupTimeoutMs

  const assetsDir = typeof parsed.assetsDir === 'string' ? parsed.assetsDir : undefined

  return { host, port, database, username, password, dataDir, startupTimeoutMs, assetsDir }
}
