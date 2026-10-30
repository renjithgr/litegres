/**
 * Daemon configuration: typed, validated, merged from
 * CLI args > environment > config file > defaults.
 */
import { DEFAULTS } from "./defaults";
import { envToConfig, envValues } from "./environment";
import { ApiError } from "../api/errors";

export interface DaemonConfig {
  host: string;
  port: number;
  maxDatabases: number;
  maxTemplates: number;
  maxDatabasesPerSession: number;
  defaultDatabaseTtlSeconds: number;
  maximumDatabaseTtlSeconds: number;
  defaultSessionTtlSeconds: number;
  maximumSessionTtlSeconds: number;
  reaperIntervalSeconds: number;
  maxInitStatements: number;
  maxInitPayloadBytes: number;
  maxExecSqlBytes: number;
  maxExecRows: number;
  execTimeoutMs: number;
  databaseCloseTimeoutMs: number;
  shutdownTimeoutMs: number;
  controlApiReadinessTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logFormat: "json" | "human";
  runtimeDir?: string;
  controlToken?: string;
  configFile?: string;
  rejectNonLocalBind: boolean;
  initialMemoryBytes: number;
  dataPlanePortBase: number;
  dataPlanePortCount: number;
  publicHost?: string;
  publicPortBase?: number;
  engine: "native" | "pglite";
  postgresUrl?: string;
  postgresDocker: boolean;
  keepPostgres: boolean;
  postgresImage: string;
  namePrefix: string;
}

export function defaultConfig(): DaemonConfig {
  return {
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    maxDatabases: DEFAULTS.maxDatabases,
    maxTemplates: DEFAULTS.maxTemplates,
    maxDatabasesPerSession: DEFAULTS.maxDatabasesPerSession,
    defaultDatabaseTtlSeconds: DEFAULTS.defaultDatabaseTtlSeconds,
    maximumDatabaseTtlSeconds: DEFAULTS.maximumDatabaseTtlSeconds,
    defaultSessionTtlSeconds: DEFAULTS.defaultSessionTtlSeconds,
    maximumSessionTtlSeconds: DEFAULTS.maximumSessionTtlSeconds,
    reaperIntervalSeconds: DEFAULTS.reaperIntervalSeconds,
    maxInitStatements: DEFAULTS.maxInitStatements,
    maxInitPayloadBytes: DEFAULTS.maxInitPayloadBytes,
    maxExecSqlBytes: DEFAULTS.maxExecSqlBytes,
    maxExecRows: DEFAULTS.maxExecRows,
    execTimeoutMs: DEFAULTS.execTimeoutMs,
    databaseCloseTimeoutMs: DEFAULTS.databaseCloseTimeoutMs,
    shutdownTimeoutMs: DEFAULTS.shutdownTimeoutMs,
    controlApiReadinessTimeoutMs: DEFAULTS.controlApiReadinessTimeoutMs,
    logLevel: DEFAULTS.logLevel,
    logFormat: DEFAULTS.logFormat,
    rejectNonLocalBind: true,
    initialMemoryBytes: DEFAULTS.initialMemoryBytes,
    dataPlanePortBase: DEFAULTS.dataPlanePortBase,
    dataPlanePortCount: DEFAULTS.dataPlanePortCount,
    publicHost: DEFAULTS.publicHost,
    publicPortBase: DEFAULTS.publicPortBase,
    engine: DEFAULTS.engine,
    postgresUrl: DEFAULTS.postgresUrl,
    postgresDocker: DEFAULTS.postgresDocker,
    keepPostgres: DEFAULTS.keepPostgres,
    postgresImage: DEFAULTS.postgresImage,
    namePrefix: DEFAULTS.namePrefix,
  };
}

/**
 * Load and validate configuration. Order of precedence (highest first):
 * cli overrides, environment, config file, defaults.
 */
export function loadConfig(opts: {
  cli?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string | undefined;
}): DaemonConfig {
  const readFile =
    opts.readFile ??
    ((path: string) => {
      try {
        return Bun.file(path).text().then((t) => t).catch(() => undefined) as unknown as string | undefined;
      } catch {
        return undefined;
      }
    });

  const env = envValues(opts.env);
  const envCfg = envToConfig(env);
  const cliCfg = opts.cli ?? {};

  let fileCfg: Record<string, unknown> = {};
  const filePath =
    typeof cliCfg.configFile === "string"
      ? cliCfg.configFile
      : typeof envCfg.configFile === "string"
        ? envCfg.configFile
        : undefined;
  if (filePath) {
    const raw = readFile(filePath);
    if (raw === undefined) {
      throw new ApiError(
        "INVALID_CONFIGURATION",
        `Configuration file not found: ${filePath}`,
        500,
      );
    }
    fileCfg = parseConfigFile(raw, filePath);
  }

  const merged = { ...defaultConfig(), ...fileCfg, ...envCfg, ...cliCfg };
  return validateConfig(merged as unknown as Record<string, unknown>);
}

function parseConfigFile(raw: string, path: string): Record<string, unknown> {
  // Support a minimal JSON config file (the only format we define for the MVP).
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ApiError(
      "INVALID_CONFIGURATION",
      `Invalid configuration file ${path}: ${(err as Error).message}`,
      500,
    );
  }
}

export function validateConfig(raw: Record<string, unknown>): DaemonConfig {
  const errors: string[] = [];
  const cfg = { ...defaultConfig(), ...raw } as unknown as DaemonConfig;

  if (!isLocalHost(cfg.host) && cfg.rejectNonLocalBind) {
    errors.push(
      `host "${cfg.host}" is not a loopback address; Litegres refuses non-local bindings by default (set LITEGRES_REJECT_NON_LOCAL_BIND=false to override)`,
    );
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    errors.push(`port must be an integer in [0, 65535], got ${cfg.port}`);
  }
  if (!Number.isInteger(cfg.dataPlanePortBase) || cfg.dataPlanePortBase < 1 || cfg.dataPlanePortBase > 65535) {
    errors.push(`dataPlanePortBase must be an integer in [1, 65535], got ${cfg.dataPlanePortBase}`);
  }
  if (!Number.isInteger(cfg.dataPlanePortCount) || cfg.dataPlanePortCount < 0 || cfg.dataPlanePortCount > 2000) {
    errors.push(`dataPlanePortCount must be an integer in [0, 2000], got ${cfg.dataPlanePortCount}`);
  }
  if (cfg.dataPlanePortCount > 0) {
    const last = cfg.dataPlanePortBase + cfg.dataPlanePortCount - 1;
    if (last > 65535) {
      errors.push(
        `dataPlanePortBase + dataPlanePortCount exceeds 65535 (base ${cfg.dataPlanePortBase}, count ${cfg.dataPlanePortCount})`,
      );
    }
    if (cfg.port >= cfg.dataPlanePortBase && cfg.port <= last) {
      errors.push(
        `control port ${cfg.port} overlaps the data-plane port range [${cfg.dataPlanePortBase}, ${last}]`,
      );
    }
  }
  if (cfg.publicPortBase !== undefined) {
    if (!Number.isInteger(cfg.publicPortBase) || cfg.publicPortBase < 1 || cfg.publicPortBase > 65535) {
      errors.push(`publicPortBase must be an integer in [1, 65535], got ${cfg.publicPortBase}`);
    } else if (cfg.publicPortBase + (cfg.dataPlanePortCount > 0 ? cfg.dataPlanePortCount - 1 : 0) > 65535) {
      errors.push(`publicPortBase + dataPlanePortCount exceeds 65535 (base ${cfg.publicPortBase}, count ${cfg.dataPlanePortCount})`);
    }
  }
  if (cfg.engine !== "native" && cfg.engine !== "pglite") {
    errors.push(`engine must be "native" or "pglite", got ${String(cfg.engine)}`);
  }
  if (cfg.postgresUrl !== undefined && !/^postgres(ql)?:\/\//.test(String(cfg.postgresUrl))) {
    errors.push("postgresUrl must start with postgres:// or postgresql://");
  }
  if (typeof cfg.namePrefix !== "string" || !/^[a-z][a-z0-9_]{0,24}$/.test(cfg.namePrefix)) {
    errors.push("namePrefix must be 1-25 characters of [a-z0-9_] starting with a letter");
  }
  for (const key of [
    "maxDatabases",
    "maxTemplates",
    "maxDatabasesPerSession",
    "defaultDatabaseTtlSeconds",
    "maximumDatabaseTtlSeconds",
    "defaultSessionTtlSeconds",
    "maximumSessionTtlSeconds",
    "reaperIntervalSeconds",
    "maxInitStatements",
    "maxExecRows",
  ] as const) {
    const v = cfg[key] as unknown;
    if (!Number.isInteger(v) || (v as number) <= 0) {
      errors.push(`${key} must be a positive integer, got ${String(v)}`);
    }
  }
  for (const key of [
    "maxInitPayloadBytes",
    "maxExecSqlBytes",
    "execTimeoutMs",
    "databaseCloseTimeoutMs",
    "shutdownTimeoutMs",
  ] as const) {
    const v = cfg[key] as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      errors.push(`${key} must be a positive number, got ${String(v)}`);
    }
  }
  if (cfg.maximumDatabaseTtlSeconds < cfg.defaultDatabaseTtlSeconds) {
    errors.push("maximumDatabaseTtlSeconds must be >= defaultDatabaseTtlSeconds");
  }
  if (cfg.maximumSessionTtlSeconds < cfg.defaultSessionTtlSeconds) {
    errors.push("maximumSessionTtlSeconds must be >= defaultSessionTtlSeconds");
  }
  if (!["debug", "info", "warn", "error"].includes(cfg.logLevel)) {
    errors.push(`logLevel must be one of debug|info|warn|error, got ${cfg.logLevel}`);
  }
  if (!["json", "human"].includes(cfg.logFormat)) {
    errors.push(`logFormat must be one of json|human, got ${cfg.logFormat}`);
  }
  if (cfg.controlToken !== undefined && (typeof cfg.controlToken !== "string" || cfg.controlToken.length < 16)) {
    errors.push("controlToken must be a string of at least 16 characters");
  }

  if (errors.length > 0) {
    throw new ApiError(
      "INVALID_CONFIGURATION",
      `Invalid configuration:\n- ${errors.join("\n- ")}`,
      500,
      { errors },
    );
  }
  return cfg;
}

export function isLocalHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "0:0:0:0:0:0:0:1"
  );
}

/** Parse CLI-style `--key value` pairs into a config fragment. */
export function cliOverridesToConfig(args: Record<string, string | number | boolean>): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  const intKeys = [
    "port",
    "max-databases",
    "max-templates",
    "max-databases-per-session",
    "database-ttl",
    "max-database-ttl",
    "session-ttl",
    "max-session-ttl",
    "reaper-interval",
    "data-plane-port-base",
    "data-plane-port-count",
    "public-port-base",
  ] as const;
  const configKey: Record<string, string> = {
    "max-databases": "maxDatabases",
    "max-templates": "maxTemplates",
    "max-databases-per-session": "maxDatabasesPerSession",
    "database-ttl": "defaultDatabaseTtlSeconds",
    "max-database-ttl": "maximumDatabaseTtlSeconds",
    "session-ttl": "defaultSessionTtlSeconds",
    "max-session-ttl": "maximumSessionTtlSeconds",
    "reaper-interval": "reaperIntervalSeconds",
    "data-plane-port-base": "dataPlanePortBase",
    "data-plane-port-count": "dataPlanePortCount",
    "public-port-base": "publicPortBase",
    "log-level": "logLevel",
    "log-format": "logFormat",
    "runtime-dir": "runtimeDir",
    "config-file": "configFile",
    "control-token": "controlToken",
  };
  for (const key of intKeys) {
    if (args[key] !== undefined) {
      const v = Number(args[key]);
      if (!Number.isInteger(v) || v <= 0) {
        throw new ApiError("INVALID_CONFIGURATION", `--${key} must be a positive integer, got ${String(args[key])}`, 500);
      }
      cfg[configKey[key] ?? key] = v;
    }
  }
  if (args.host !== undefined) cfg.host = String(args.host);
  if (args.engine !== undefined) cfg.engine = String(args.engine);
  if (args["postgres-url"] !== undefined) cfg.postgresUrl = String(args["postgres-url"]);
  if (args["postgres-image"] !== undefined) cfg.postgresImage = String(args["postgres-image"]);
  if (args["name-prefix"] !== undefined) cfg.namePrefix = String(args["name-prefix"]);
  if (args["postgres-docker"] !== undefined) cfg.postgresDocker = args["postgres-docker"] !== false && args["postgres-docker"] !== "false";
  if (args["keep-postgres"] !== undefined) cfg.keepPostgres = args["keep-postgres"] !== false && args["keep-postgres"] !== "false";
  if (args["public-host"] !== undefined) cfg.publicHost = String(args["public-host"]);
  if (args["log-level"] !== undefined) cfg.logLevel = String(args["log-level"]);
  if (args["log-format"] !== undefined) cfg.logFormat = String(args["log-format"]);
  if (args["runtime-dir"] !== undefined) cfg.runtimeDir = String(args["runtime-dir"]);
  if (args["config-file"] !== undefined) cfg.configFile = String(args["config-file"]);
  if (args["control-token"] !== undefined) cfg.controlToken = String(args["control-token"]);
  if (args["reject-non-local-bind"] !== undefined)
    cfg.rejectNonLocalBind = args["reject-non-local-bind"] !== "false";
  return cfg;
}
