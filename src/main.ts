/**
 * litegresd — Litegres daemon executable entry point.
 *
 * Foreground commands run the daemon in this process; all other commands
 * talk to a running daemon through the control API.
 */
import { Daemon, VERSION } from "./daemon";
import { loadConfig, cliOverridesToConfig, type DaemonConfig } from "./config/config";
import { Logger } from "./observability/logger";
import { ApiError } from "./api/errors";
import {
  cmdDatabaseCreate,
  cmdDatabaseDelete,
  cmdDatabaseGet,
  cmdDatabases,
  cmdGc,
  cmdSessionClose,
  cmdSessionCreate,
  cmdSessionGet,
  cmdSessions,
  cmdStatus,
  cmdStop,
  cmdTemplateCreate,
  cmdTemplateFinalize,
  cmdTemplateGet,
  cmdTemplateList,
  cmdVersion,
  type CliContext,
} from "./cli/commands";
import type { OutputFormat } from "./cli/output";
import { resolveRuntimeDir } from "./security/runtime-directory";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HELP = `litegresd ${VERSION}

Usage:
  litegresd run [options]                 Run the daemon in the foreground
  litegresd start [--background]          Start the daemon (foreground by default)
  litegresd status [--json]               Show daemon status
  litegresd stop                          Shut down the daemon gracefully
  litegresd gc                            Run one reaper pass
  litegresd databases [--json]            List databases
  litegresd templates [--json]            List templates
  litegresd sessions [--json]             List sessions
  litegresd version [--json]              Print version info
  litegresd database create [options]     Create a database
  litegresd database get <id>             Get a database
  litegresd database delete <id>          Destroy a database
  litegresd template create [options]     Create a template (statements or provisioning)
  litegresd template get <id>             Get a template
  litegresd template list                 List templates
  litegresd template finalize <id>        Finalize a provisioning template
  litegresd session create [options]      Create a session
  litegresd session get <id>              Get a session
  litegresd session close <id>            Close a session

Options:
  --host <host>                Bind host (default 127.0.0.1)
  --port <port>                Control API port (default 49100)
  --max-databases <n>          Maximum databases (default 32)
  --max-templates <n>          Maximum templates (default 8)
  --max-databases-per-session <n>
  --database-ttl <seconds>     Default database TTL (default 600)
  --session-ttl <seconds>      Default session TTL (default 1800)
  --runtime-dir <path>         Runtime directory override
  --log-level <level>          debug|info|warn|error
  --log-format <format>        json|human
  --data-plane-port-base <n>   First data-plane port (default 49152)
  --data-plane-port-count <n>  Fixed data-plane range size (0 = OS-assigned)
  --public-host <host>         Host advertised in connection info (Docker)
  --public-port-base <n>       Advertised data-plane port base (Docker)
  --engine <native|pglite>     Database engine (default native)
  --postgres-url <url>         Admin URL of the PostgreSQL server (native engine)
  --postgres-docker <bool>     Start a postgres container if no URL is given (default true)
  --keep-postgres              Leave the managed postgres container running on exit
  --postgres-image <image>     Image for the managed container (default postgres:17-alpine)
  --name-prefix <prefix>       Prefix of created databases (default litegres_)
  --json                       JSON output (client commands)
  --background                 Detach the daemon (start command)
  --control-token <token>      Daemon control token
  --config-file <path>         JSON configuration file

Environment:
  LITEGRES_HOST, LITEGRES_PORT, LITEGRES_MAX_DATABASES, LITEGRES_MAX_TEMPLATES,
  LITEGRES_MAX_DATABASES_PER_SESSION, LITEGRES_DATABASE_TTL_SECONDS,
  LITEGRES_MAX_DATABASE_TTL_SECONDS, LITEGRES_SESSION_TTL_SECONDS,
  LITEGRES_MAX_SESSION_TTL_SECONDS, LITEGRES_REAPER_INTERVAL_SECONDS,
  LITEGRES_RUNTIME_DIR, LITEGRES_LOG_LEVEL, LITEGRES_LOG_FORMAT,
  LITEGRES_CONTROL_TOKEN, LITEGRES_CONFIG_FILE,
  LITEGRES_DATA_PLANE_PORT_BASE, LITEGRES_DATA_PLANE_PORT_COUNT,
  LITEGRES_PUBLIC_HOST, LITEGRES_PUBLIC_PORT_BASE,
  LITEGRES_ENGINE, LITEGRES_POSTGRES_URL, LITEGRES_POSTGRES_DOCKER,
  LITEGRES_KEEP_POSTGRES, LITEGRES_POSTGRES_IMAGE, LITEGRES_NAME_PREFIX
`;

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | number | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        flags[key] = parseFlagValue(arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = parseFlagValue(next);
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
    i++;
  }
  const command = positional[0] ?? "help";
  const subcommand = positional[1];
  return { command, subcommand, positional: positional.slice(2), flags };
}

function parseFlagValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  if (value !== "" && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(value)) return n;
  return value;
}

function outputFormat(flags: Record<string, unknown>): OutputFormat {
  return flags.json === true ? "json" : "human";
}

function cliContext(flags: Record<string, string | number | boolean>): CliContext {
  return {
    output: { format: outputFormat(flags) },
    runtimeDirOverride: typeof flags["runtime-dir"] === "string" ? flags["runtime-dir"] : undefined,
    controlUrl:
      flags["control-url"] !== undefined
        ? String(flags["control-url"])
        : flags.port !== undefined && flags.host !== undefined
          ? `http://${flags.host}:${flags.port}`
          : flags.port !== undefined
            ? `http://127.0.0.1:${flags.port}`
            : undefined,
    token: typeof flags["control-token"] === "string" ? flags["control-token"] : undefined,
  };
}

async function runForeground(flags: Record<string, string | number | boolean>): Promise<never> {
  const config = buildConfig(flags);
  const logger = new Logger({ level: config.logLevel, format: config.logFormat });
  const daemon = new Daemon({ config, logger });
  await daemon.start();
  // Stay alive; signal handlers drive shutdown. Exit when shutdown completes.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (daemon.state === "STOPPED" || daemon.state === "FAILED") {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  process.exit(daemon.state === "STOPPED" ? 0 : 1);
}

function buildConfig(flags: Record<string, string | number | boolean>): DaemonConfig {
  const cli = cliOverridesToConfig(flags);
  return loadConfig({ cli });
}

async function startBackground(flags: Record<string, string | number | boolean>): Promise<void> {
  const runtimeDir = resolveRuntimeDir(
    typeof flags["runtime-dir"] === "string" ? String(flags["runtime-dir"]) : undefined,
  );
  mkdirSync(runtimeDir, { recursive: true });
  const logFile = join(runtimeDir, "daemon.log");
  const logFd = Bun.file(logFile);
  void logFd;

  const runArgs: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (key === "background") continue;
    if (value === true) runArgs.push(`--${key}`);
    else runArgs.push(`--${key}`, String(value));
  }

  const isCompiled = process.execPath.includes("litegresd");
  const spawnArgs = isCompiled
    ? ["run", ...runArgs]
    : [import.meta.path, "run", ...runArgs];
  const spawnPath = isCompiled ? process.execPath : process.execPath;

  const proc = Bun.spawn([process.execPath, ...spawnArgs], {
    cwd: process.cwd(),
    env: { ...process.env, LITEGRES_DAEMONIZED: "1" },
    detached: true,
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
  });
  proc.unref();

  // Wait for the discovery file to appear (bounded).
  const discoveryPath = join(runtimeDir, "daemon.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(discoveryPath)) {
      const text = Bun.file(discoveryPath).text();
      const discovery = JSON.parse(await text) as { pid?: number; controlUrl?: string };
      console.log(`Litegres daemon started (pid ${discovery.pid ?? "unknown"}) at ${discovery.controlUrl}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.error("Timed out waiting for the background daemon to appear.");
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, subcommand, positional, flags } = parseArgs(argv);

  try {
    switch (command) {
      case "run":
        await runForeground(flags);
        return;
      case "start": {
        if (flags.background === true) {
          await startBackground(flags);
          return;
        }
        await runForeground(flags);
        return;
      }
      case "status":
        await cmdStatus(cliContext(flags));
        return;
      case "stop":
        await cmdStop(cliContext(flags));
        return;
      case "gc":
        await cmdGc(cliContext(flags));
        return;
      case "version":
        await cmdVersion(cliContext(flags), VERSION);
        return;
      case "databases":
        await cmdDatabases(cliContext(flags));
        return;
      case "templates":
        await cmdTemplateList(cliContext(flags));
        return;
      case "sessions":
        await cmdSessions(cliContext(flags));
        return;
      case "database": {
        const ctx = cliContext(flags);
        switch (subcommand) {
          case "create":
            await cmdDatabaseCreate(ctx, flagsToStr(flags));
            return;
          case "get":
            await cmdDatabaseGet(ctx, positional[0]!);
            return;
          case "delete":
            await cmdDatabaseDelete(ctx, positional[0]!);
            return;
          default:
            throw new ApiError("INVALID_REQUEST", `Unknown database subcommand "${subcommand ?? ""}".`, 400);
        }
      }
      case "template": {
        const ctx = cliContext(flags);
        switch (subcommand) {
          case "create":
            await cmdTemplateCreate(ctx, flagsToStr(flags));
            return;
          case "get":
            await cmdTemplateGet(ctx, positional[0]!);
            return;
          case "list":
            await cmdTemplateList(ctx);
            return;
          case "finalize":
            await cmdTemplateFinalize(ctx, positional[0]!);
            return;
          default:
            throw new ApiError("INVALID_REQUEST", `Unknown template subcommand "${subcommand ?? ""}".`, 400);
        }
      }
      case "session": {
        const ctx = cliContext(flags);
        switch (subcommand) {
          case "create":
            await cmdSessionCreate(ctx, flagsToStr(flags));
            return;
          case "get":
            await cmdSessionGet(ctx, positional[0]!);
            return;
          case "close":
            await cmdSessionClose(ctx, positional[0]!);
            return;
          default:
            throw new ApiError("INVALID_REQUEST", `Unknown session subcommand "${subcommand ?? ""}".`, 400);
        }
      }
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return;
      default:
        throw new ApiError("INVALID_REQUEST", `Unknown command "${command}". Run "litegresd help".`, 400);
    }
  } catch (err) {
    const format = outputFormat(flags);
    if (format === "json") {
      const code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
      process.stderr.write(
        JSON.stringify({ error: { code, message: (err as Error).message } }) + "\n",
      );
    } else {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  }
}

function flagsToStr(flags: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value === "boolean") out[key] = value ? "true" : "false";
    else out[key] = String(value);
  }
  return out;
}

await main();
