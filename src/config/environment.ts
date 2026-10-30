/**
 * Environment-variable configuration source.
 *
 * LITEGRES_* variables map 1:1 onto DaemonConfig fields. Values are parsed
 * leniently here and strictly validated by validateConfig().
 */
import { DEFAULTS } from "./defaults";

export interface EnvValues {
  [key: string]: string | undefined;
}

export function envValues(env: NodeJS.ProcessEnv = process.env): EnvValues {
  const out: EnvValues = {};
  const keys = [
    "LITEGRES_HOST",
    "LITEGRES_PORT",
    "LITEGRES_MAX_DATABASES",
    "LITEGRES_MAX_TEMPLATES",
    "LITEGRES_MAX_DATABASES_PER_SESSION",
    "LITEGRES_DATABASE_TTL_SECONDS",
    "LITEGRES_MAX_DATABASE_TTL_SECONDS",
    "LITEGRES_SESSION_TTL_SECONDS",
    "LITEGRES_MAX_SESSION_TTL_SECONDS",
    "LITEGRES_REAPER_INTERVAL_SECONDS",
    "LITEGRES_RUNTIME_DIR",
    "LITEGRES_LOG_LEVEL",
    "LITEGRES_LOG_FORMAT",
    "LITEGRES_CONTROL_TOKEN",
    "LITEGRES_CONFIG_FILE",
    "LITEGRES_BIND_CONTROL_TOKEN",
    "LITEGRES_REJECT_NON_LOCAL_BIND",
    "LITEGRES_PUBLIC_HOST",
    "LITEGRES_PUBLIC_PORT",
    "LITEGRES_POSTGRES_URL",
    "LITEGRES_POSTGRES_DOCKER",
    "LITEGRES_KEEP_POSTGRES",
    "LITEGRES_POSTGRES_IMAGE",
    "LITEGRES_NAME_PREFIX",
  ] as const;
  for (const key of keys) {
    const v = env[key];
    if (v !== undefined && v !== "") out[key] = v;
  }
  return out;
}

/** Convert raw env strings into typed config fragments. */
export function envToConfig(env: EnvValues): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (env.LITEGRES_HOST !== undefined) cfg.host = env.LITEGRES_HOST;
  if (env.LITEGRES_PORT !== undefined) cfg.port = parsePosInt(env.LITEGRES_PORT, "LITEGRES_PORT");
  if (env.LITEGRES_MAX_DATABASES !== undefined)
    cfg.maxDatabases = parsePosInt(env.LITEGRES_MAX_DATABASES, "LITEGRES_MAX_DATABASES");
  if (env.LITEGRES_MAX_TEMPLATES !== undefined)
    cfg.maxTemplates = parsePosInt(env.LITEGRES_MAX_TEMPLATES, "LITEGRES_MAX_TEMPLATES");
  if (env.LITEGRES_MAX_DATABASES_PER_SESSION !== undefined)
    cfg.maxDatabasesPerSession = parsePosInt(
      env.LITEGRES_MAX_DATABASES_PER_SESSION,
      "LITEGRES_MAX_DATABASES_PER_SESSION",
    );
  if (env.LITEGRES_DATABASE_TTL_SECONDS !== undefined)
    cfg.defaultDatabaseTtlSeconds = parsePosInt(env.LITEGRES_DATABASE_TTL_SECONDS, "LITEGRES_DATABASE_TTL_SECONDS");
  if (env.LITEGRES_MAX_DATABASE_TTL_SECONDS !== undefined)
    cfg.maximumDatabaseTtlSeconds = parsePosInt(env.LITEGRES_MAX_DATABASE_TTL_SECONDS, "LITEGRES_MAX_DATABASE_TTL_SECONDS");
  if (env.LITEGRES_SESSION_TTL_SECONDS !== undefined)
    cfg.defaultSessionTtlSeconds = parsePosInt(env.LITEGRES_SESSION_TTL_SECONDS, "LITEGRES_SESSION_TTL_SECONDS");
  if (env.LITEGRES_MAX_SESSION_TTL_SECONDS !== undefined)
    cfg.maximumSessionTtlSeconds = parsePosInt(env.LITEGRES_MAX_SESSION_TTL_SECONDS, "LITEGRES_MAX_SESSION_TTL_SECONDS");
  if (env.LITEGRES_REAPER_INTERVAL_SECONDS !== undefined)
    cfg.reaperIntervalSeconds = parsePosInt(env.LITEGRES_REAPER_INTERVAL_SECONDS, "LITEGRES_REAPER_INTERVAL_SECONDS");
  if (env.LITEGRES_RUNTIME_DIR !== undefined) cfg.runtimeDir = env.LITEGRES_RUNTIME_DIR;
  if (env.LITEGRES_LOG_LEVEL !== undefined) cfg.logLevel = env.LITEGRES_LOG_LEVEL;
  if (env.LITEGRES_LOG_FORMAT !== undefined) cfg.logFormat = env.LITEGRES_LOG_FORMAT;
  if (env.LITEGRES_CONTROL_TOKEN !== undefined) cfg.controlToken = env.LITEGRES_CONTROL_TOKEN;
  if (env.LITEGRES_CONFIG_FILE !== undefined) cfg.configFile = env.LITEGRES_CONFIG_FILE;
  if (env.LITEGRES_REJECT_NON_LOCAL_BIND !== undefined)
    cfg.rejectNonLocalBind = env.LITEGRES_REJECT_NON_LOCAL_BIND === "true" || env.LITEGRES_REJECT_NON_LOCAL_BIND === "1";
  if (env.LITEGRES_PUBLIC_HOST !== undefined) cfg.publicHost = env.LITEGRES_PUBLIC_HOST;
  if (env.LITEGRES_PUBLIC_PORT !== undefined)
    cfg.publicPort = parsePosInt(env.LITEGRES_PUBLIC_PORT, "LITEGRES_PUBLIC_PORT");
  if (env.LITEGRES_POSTGRES_URL !== undefined) cfg.postgresUrl = env.LITEGRES_POSTGRES_URL;
  if (env.LITEGRES_POSTGRES_DOCKER !== undefined)
    cfg.postgresDocker = env.LITEGRES_POSTGRES_DOCKER === "true" || env.LITEGRES_POSTGRES_DOCKER === "1";
  if (env.LITEGRES_KEEP_POSTGRES !== undefined)
    cfg.keepPostgres = env.LITEGRES_KEEP_POSTGRES === "true" || env.LITEGRES_KEEP_POSTGRES === "1";
  if (env.LITEGRES_POSTGRES_IMAGE !== undefined) cfg.postgresImage = env.LITEGRES_POSTGRES_IMAGE;
  if (env.LITEGRES_NAME_PREFIX !== undefined) cfg.namePrefix = env.LITEGRES_NAME_PREFIX;
  return cfg;
}

function parsePosInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${value}"`);
  }
  return n;
}

export { DEFAULTS };
