/**
 * Default configuration values.
 */

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 49100,
  maxDatabases: 32,
  maxTemplates: 8,
  maxDatabasesPerSession: 16,
  defaultDatabaseTtlSeconds: 600,
  maximumDatabaseTtlSeconds: 3600,
  defaultSessionTtlSeconds: 1800,
  maximumSessionTtlSeconds: 14400,
  reaperIntervalSeconds: 10,
  maxInitStatements: 100,
  maxInitPayloadBytes: 1_048_576, // 1 MiB
  maxExecSqlBytes: 1_048_576,
  maxExecRows: 1000,
  execTimeoutMs: 5000,
  databaseCloseTimeoutMs: 10_000,
  shutdownTimeoutMs: 15_000,
  controlApiReadinessTimeoutMs: 5_000,
  logLevel: "info" as "debug" | "info" | "warn" | "error",
  logFormat: "json" as "json" | "human",
  /** Override the host advertised in connection info (Docker: "localhost"). */
  publicHost: undefined as string | undefined,
  /** Override the PostgreSQL port advertised in connection info (fixed Docker port mapping). */
  publicPort: undefined as number | undefined,
  // PostgreSQL server used to host every database (the only engine).
  /** Admin URL of the PostgreSQL server. */
  postgresUrl: undefined as string | undefined,
  /** Start a managed postgres container when no postgresUrl is given. */
  postgresDocker: true,
  /** Leave the managed postgres container running on shutdown. */
  keepPostgres: false,
  postgresImage: "postgres:17-alpine",
  /** Prefix of every database the daemon creates (and sweeps on start). */
  namePrefix: "litegres_",
} as const;

export type Defaults = typeof DEFAULTS;
