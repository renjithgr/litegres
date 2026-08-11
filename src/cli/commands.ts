/**
 * CLI commands. Every command that touches a daemon talks to the control
 * plane through the LitegresClient — never to internal registries.
 */
import { LitegresClient, type CreateDatabaseOptions, type CreateSessionOptions, type CreateTemplateOptions } from "../../clients/typescript/src/index";
import { printMessage, printResult, type OutputOptions } from "./output";
import { resolveRuntimeDir, readDiscoveryFile, isPidAlive } from "../../clients/typescript/src/discovery";
import { ApiError } from "../api/errors";

export interface CliContext {
  output: OutputOptions;
  runtimeDirOverride?: string;
  controlUrl?: string;
  token?: string;
}

async function client(ctx: CliContext): Promise<LitegresClient> {
  return LitegresClient.connect({
    controlUrl: ctx.controlUrl,
    token: ctx.token,
    runtimeDirOverride: ctx.runtimeDirOverride,
  });
}

function findPid(ctx: CliContext): number | undefined {
  const discovery = readDiscoveryFile(resolveRuntimeDir(ctx.runtimeDirOverride));
  if (discovery && isPidAlive(discovery.pid)) return discovery.pid;
  return undefined;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function cmdSessionCreate(ctx: CliContext, args: Record<string, string>): Promise<void> {
  const c = await client(ctx);
  const options: CreateSessionOptions = {
    client: {
      name: args["client-name"] ?? "litegresd-cli",
      version: args["client-version"],
      framework: args["client-framework"],
    },
    ttlSeconds: args.ttl ? Number(args.ttl) : undefined,
    metadata: parseMetadata(args.metadata),
  };
  const session = await c.createSession(options);
  printResult(session, ctx.output);
}

export async function cmdSessionGet(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  printResult(await c.getSession(id), ctx.output);
}

export async function cmdSessionClose(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  await c.deleteSession(id);
  printMessage(`Session ${id} closed.`, ctx.output);
}

export async function cmdSessions(ctx: CliContext): Promise<void> {
  const c = await client(ctx);
  const { sessions } = await c.listSessions();
  printResult(sessions, ctx.output);
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export async function cmdDatabaseCreate(ctx: CliContext, args: Record<string, string>): Promise<void> {
  const c = await client(ctx);
  const options: CreateDatabaseOptions = {
    sessionId: args.session,
    templateId: args.template,
    ttlSeconds: args.ttl ? Number(args.ttl) : undefined,
    metadata: parseMetadata(args.metadata),
  };
  if (args.statements) {
    options.initialization = { statements: JSON.parse(args.statements) as string[] };
  }
  const db = await c.createDatabase(options);
  printResult(db, ctx.output);
}

export async function cmdDatabaseGet(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  printResult(await c.getDatabase(id), ctx.output);
}

export async function cmdDatabaseDelete(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  await c.deleteDatabase(id);
  printMessage(`Database ${id} destroyed.`, ctx.output);
}

export async function cmdDatabases(ctx: CliContext): Promise<void> {
  const c = await client(ctx);
  const { databases } = await c.listDatabases();
  printResult(databases, ctx.output);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function cmdTemplateCreate(ctx: CliContext, args: Record<string, string>): Promise<void> {
  const c = await client(ctx);
  const options: CreateTemplateOptions = {
    name: args.name,
    fingerprint: args.fingerprint ?? args["fingerprint"] ?? "",
    metadata: parseMetadata(args.metadata),
  };
  if (args.statements) {
    options.initialization = { statements: JSON.parse(args.statements) as string[] };
  }
  if (!options.fingerprint) {
    throw new ApiError("INVALID_REQUEST", "template create requires --fingerprint (or --statements to derive from).", 400);
  }
  const template = options.initialization
    ? await c.putTemplate(options)
    : await c.createTemplate(options);
  printResult(template, ctx.output);
}

export async function cmdTemplateGet(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  printResult(await c.getTemplate(id), ctx.output);
}

export async function cmdTemplateList(ctx: CliContext): Promise<void> {
  const c = await client(ctx);
  const { templates } = await c.listTemplates();
  printResult(templates, ctx.output);
}

export async function cmdTemplateFinalize(ctx: CliContext, id: string): Promise<void> {
  const c = await client(ctx);
  printResult(await c.finalizeTemplate(id), ctx.output);
}

// ---------------------------------------------------------------------------
// Daemon commands
// ---------------------------------------------------------------------------

export async function cmdStatus(ctx: CliContext): Promise<void> {
  const c = await client(ctx);
  printResult(await c.status(), ctx.output);
}

export async function cmdGc(ctx: CliContext): Promise<void> {
  const c = await client(ctx);
  printResult(await c.gc(), ctx.output);
}

export async function cmdStop(ctx: CliContext): Promise<void> {
  const pid = findPid(ctx);
  if (pid === undefined) {
    printMessage("No running Litegres daemon found.", ctx.output);
    return;
  }
  const c = await client(ctx);
  try {
    await c.shutdown();
  } catch {
    // The daemon closes the control API while responding; a connection
    // reset here usually means shutdown is already underway.
  }
  // Wait (bounded) for the daemon to exit.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (findPid(ctx) === undefined) {
      printMessage(`Litegres daemon (pid ${pid}) stopped.`, ctx.output);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  printMessage(`Shutdown requested for Litegres daemon (pid ${pid}); still stopping.`, ctx.output);
}

export async function cmdVersion(ctx: CliContext, version: string): Promise<void> {
  printResult({ name: "litegres", version, bun: Bun.version }, ctx.output);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseMetadata(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      throw new ApiError("INVALID_REQUEST", `Metadata entry "${pair}" must be key=value.`, 400);
    }
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}
