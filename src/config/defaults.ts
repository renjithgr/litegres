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
  // PGlite initial WASM memory per instance. PGlite's default is 128 MiB;
  // we keep the default and document that it grows on demand.
  initialMemoryBytes: 128 * 1024 * 1024,
  // Data-plane (PostgreSQL) port allocation. count = 0 keeps the original
  // behavior: each database binds an OS-assigned port. Setting a positive
  // count makes databases bind consecutive ports starting at `base`, which
  // is required when the daemon runs behind Docker port publishing or any
  // other fixed-port environment.
  dataPlanePortBase: 49152,
  dataPlanePortCount: 0,
  /** Override the host advertised in connection info (Docker: "localhost"). */
  publicHost: undefined as string | undefined,
  /** Override the advertised data-plane port base (fixed-port mapping). */
  publicPortBase: undefined as number | undefined,
} as const;

export type Defaults = typeof DEFAULTS;
