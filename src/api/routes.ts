/**
 * Route table and request validation for the control plane.
 */
import { ApiError } from "./errors";
import { json, created, noContent, buildConnection, databaseDescriptor, sessionDescriptor, templateDescriptor } from "./responses";
import { advertisedEndpoint } from "../config/advertised";
import type { AuthActor, AuthManager } from "../security/auth";
import type { DaemonConfig } from "../config/config";
import type { Clock } from "../clock";
import type { DatabaseRegistry } from "../registry/database-registry";
import type { SessionRegistry } from "../registry/session-registry";
import type { TemplateRegistry } from "../registry/template-registry";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import type { Reaper } from "../lifecycle/reaper";
import { isLocalHost } from "../config/config";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildOpenApiDocument } from "./openapi";

export const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// Build-time constant set by scripts/build.ts via define (plain identifier so
// Bun's --define matches it; source mode falls back to a runtime probe).
declare const __PGLITE_VERSION__: string | undefined;

export interface ApiContext {
  config: DaemonConfig;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  databases: DatabaseRegistry;
  sessions: SessionRegistry;
  templates: TemplateRegistry;
  auth: AuthManager;
  daemon: {
    state(): string;
    startedAt: Date;
    version: string;
    controlUrl: string;
    postgresVersion: string | undefined;
    shutdown(reason: string): Promise<void>;
    runReaperOnce(): Promise<Reaper["runOnce"] extends (() => Promise<infer R>) ? R : never>;
  };
}

export interface RouteRequest {
  request: Request;
  params: Record<string, string>;
  actor: AuthActor | undefined;
  requestId: string;
  ctx: ApiContext;
}

export type Handler = (req: RouteRequest) => Promise<Response> | Response;

export type AuthRequirement = "none" | "daemon" | "any";

export interface Route {
  method: string;
  /** Path pattern with :param placeholders. */
  path: string;
  auth: AuthRequirement;
  handler: Handler;
}

export function routes(ctx: ApiContext): Route[] {
  const R = (
    method: string,
    path: string,
    auth: AuthRequirement,
    handler: Handler,
  ): Route => ({ method, path, auth, handler });

  return [
    // Health (unauthenticated on localhost)
    R("GET", "/health/live", "none", () => json({ status: "ok" })),
    R("GET", "/health/ready", "none", (req) =>
      req.ctx.daemon.state() === "READY"
        ? json({ status: "ready" })
        : json({ status: "not_ready", daemonState: req.ctx.daemon.state() }, 503),
    ),

    // Status / diagnostics
    R("GET", "/v1/status", "none", (req) => json(statusBody(req.ctx))),
    R("GET", "/v1/metrics", "none", (req) =>
      json({ metrics: req.ctx.metrics.snapshot() }),
    ),
    R("GET", "/v1/openapi.json", "none", () =>
      json(buildOpenApiDocument(ctx.daemon.version), 200, { "content-type": "application/json" }),
    ),

    // Sessions
    R("POST", "/v1/sessions", "daemon", createSession),
    R("GET", "/v1/sessions", "daemon", listSessions),
    R("GET", "/v1/sessions/:id", "any", getSession),
    R("DELETE", "/v1/sessions/:id", "any", deleteSession),
    R("POST", "/v1/sessions/:id/renew", "any", renewSession),

    // Databases
    R("POST", "/v1/databases", "any", createDatabase),
    R("GET", "/v1/databases", "daemon", listDatabases),
    R("GET", "/v1/databases/:id", "any", getDatabase),
    R("DELETE", "/v1/databases/:id", "any", deleteDatabase),
    R("POST", "/v1/databases/:id/renew", "any", renewDatabase),
    R("POST", "/v1/databases/:id/exec", "any", execDatabase),

    // Templates
    R("PUT", "/v1/templates/:fingerprint", "daemon", putTemplate),
    R("POST", "/v1/templates", "daemon", provisionTemplate),
    R("GET", "/v1/templates", "daemon", listTemplates),
    R("GET", "/v1/templates/:id", "daemon", getTemplate),
    R("POST", "/v1/templates/:id/finalize", "daemon", finalizeTemplate),
    R("DELETE", "/v1/templates/:id", "daemon", deleteTemplate),

    // Daemon control
    R("POST", "/v1/gc", "daemon", runGc),
    R("POST", "/v1/shutdown", "daemon", shutdownDaemon),
  ];
}

// ---------------------------------------------------------------------------
// Request validation helpers
// ---------------------------------------------------------------------------

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MiB limit.", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Could not read request body.", 400);
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MiB limit.", 413);
  }
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ApiError("INVALID_REQUEST", `Invalid JSON body: ${(err as Error).message}`, 400);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("INVALID_REQUEST", `Field "${key}" must be a non-empty string.`, 400, { field: key });
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("INVALID_REQUEST", `Field "${key}" must be a string.`, 400, { field: key });
  }
  return value;
}

function ttlSeconds(body: Record<string, unknown>, fallback: number, maximum: number, field = "ttlSeconds"): number {
  const value = body[field] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ApiError("INVALID_REQUEST", `Field "${field}" must be a positive integer.`, 400, { field });
  }
  return Math.min(value, maximum);
}

function validateMetadata(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Field \"metadata\" must be an object of string values.", 400);
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) {
    throw new ApiError("INVALID_REQUEST", "Metadata supports at most 64 entries.", 400);
  }
  for (const [key, val] of entries) {
    if (typeof val !== "string") {
      throw new ApiError("INVALID_REQUEST", `Metadata key "${key}" must have a string value.`, 400, { key });
    }
    if (key.length > 128) {
      throw new ApiError("INVALID_REQUEST", `Metadata key "${key}" exceeds 128 characters.`, 400, { key });
    }
    if (val.length > 1024) {
      throw new ApiError("INVALID_REQUEST", `Metadata value for "${key}" exceeds 1024 characters.`, 400, { key });
    }
    out[key] = val;
  }
  return out;
}

function validateInitialization(value: unknown, config: DaemonConfig): { statements: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Field \"initialization\" must be an object.", 400);
  }
  const statements = (value as { statements?: unknown }).statements;
  if (statements === undefined) return { statements: [] };
  if (!Array.isArray(statements)) {
    throw new ApiError("INVALID_REQUEST", "Field \"initialization.statements\" must be an array of strings.", 400);
  }
  if (statements.length > config.maxInitStatements) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `Initialization supports at most ${config.maxInitStatements} statements.`,
      400,
    );
  }
  let totalBytes = 0;
  for (const statement of statements) {
    if (typeof statement !== "string") {
      throw new ApiError("INVALID_REQUEST", "Initialization statements must be strings.", 400);
    }
    totalBytes += statement.length;
    if (totalBytes > config.maxInitPayloadBytes) {
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        "Initialization payload exceeds the configured limit.",
        400,
      );
    }
  }
  return { statements: statements as string[] };
}

function validateStorage(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Field \"storage\" must be an object.", 400);
  }
  const type = (value as { type?: unknown }).type;
  if (type !== "memory") {
    throw new ApiError(
      "INVALID_REQUEST",
      "Only \"memory\" storage is supported in this version.",
      400,
      { storageType: type },
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function createSession(req: RouteRequest): Response {
  const body = req.request.method === "POST" ? readBodySync(req) : {};
  const ttl = ttlSeconds(body, req.ctx.config.defaultSessionTtlSeconds, req.ctx.config.maximumSessionTtlSeconds);
  const client = body.client;
  const clientInfo =
    client && typeof client === "object" && !Array.isArray(client)
      ? {
          name: optionalString(client as Record<string, unknown>, "name"),
          version: optionalString(client as Record<string, unknown>, "version"),
          pid: (client as { pid?: unknown }).pid as number | undefined,
          framework: optionalString(client as Record<string, unknown>, "framework"),
        }
      : undefined;
  const metadata = validateMetadata(body.metadata);
  const { session } = req.ctx.sessions.create({ client: clientInfo, ttlSeconds: ttl, metadata });
  return created({
    ...sessionDescriptor(session),
    leaseToken: session.leaseToken,
  });
}

function listSessions(req: RouteRequest): Response {
  const sessions = req.ctx.sessions.list().map((s) => sessionDescriptor(s));
  return json({ sessions, count: sessions.length });
}

function getSession(req: RouteRequest): Response {
  const { sessions, auth } = req.ctx;
  const session = sessions.require(req.params.id!);
  req.ctx.auth.authorizeSession(requireActor(req), session.id);
  void auth;
  return json(sessionDescriptor(session));
}

function deleteSession(req: RouteRequest): Response {
  const sessionId = req.params.id!;
  req.ctx.auth.authorizeSession(requireActor(req), sessionId);
  void req.ctx.sessions.close(sessionId);
  return noContent();
}

function renewSession(req: RouteRequest): Response {
  const body = readBodySync(req);
  const sessionId = req.params.id!;
  req.ctx.auth.authorizeSession(requireActor(req), sessionId);
  const ttl = ttlSeconds(body, req.ctx.config.defaultSessionTtlSeconds, req.ctx.config.maximumSessionTtlSeconds);
  const session = req.ctx.sessions.renew(sessionId, ttl);
  return json(sessionDescriptor(session));
}

async function createDatabase(req: RouteRequest): Promise<Response> {
  const body = readBodySync(req);
  const { databases, sessions, templates, config, auth } = req.ctx;
  const actor = requireActor(req);

  const sessionId = optionalString(body, "sessionId");
  if (sessionId) sessions.require(sessionId); // 404/expired when missing
  auth.authorizeSessionScope(actor, sessionId);
  validateStorage(body.storage);
  const ttl = ttlSeconds(body, config.defaultDatabaseTtlSeconds, config.maximumDatabaseTtlSeconds);
  const metadata = validateMetadata(body.metadata);
  const initialization = validateInitialization(body.initialization, config);

  const templateId = optionalString(body, "templateId");
  if (initialization && templateId) {
    throw new ApiError(
      "INVALID_REQUEST",
      "A database cannot combine \"templateId\" with \"initialization\"; clone a template or initialize an empty database.",
      400,
    );
  }
  let templateSnapshot;
  if (templateId) {
    templateSnapshot = templates.getSnapshot(templateId);
  }

  const createdDb = await databases.create(
    {
      sessionId,
      templateId,
      storage: { type: "memory" },
      ttlSeconds: ttl,
      metadata,
      initialization,
    },
    templateSnapshot,
  );
  return created(createdDb);
}

function listDatabases(req: RouteRequest): Response {
  const query = req.request.url.includes("?") ? new URL(req.request.url).searchParams : new URLSearchParams();
  const filter = {
    sessionId: query.get("sessionId") ?? undefined,
    templateId: query.get("templateId") ?? undefined,
    state: query.get("state") ?? undefined,
    expired: query.has("expired") ? query.get("expired") !== "false" : undefined,
    application: query.get("application") ?? undefined,
  };
  const databases = req.ctx.databases.list(filter).map((db) => databaseDescriptor(db, req.ctx.config));
  return json({ databases, count: databases.length });
}

function getDatabase(req: RouteRequest): Response {
  const db = req.ctx.databases.require(req.params.id!);
  req.ctx.auth.authorizeDatabase(requireActor(req), db.sessionId);
  return json(databaseDescriptor(db, req.ctx.config));
}

function deleteDatabase(req: RouteRequest): Response {
  const db = req.ctx.databases.get(req.params.id!);
  if (db) req.ctx.auth.authorizeDatabase(requireActor(req), db.sessionId);
  void req.ctx.databases.destroy(req.params.id!);
  return noContent();
}

function renewDatabase(req: RouteRequest): Response {
  const body = readBodySync(req);
  const db = req.ctx.databases.require(req.params.id!);
  req.ctx.auth.authorizeDatabase(requireActor(req), db.sessionId);
  const ttl = ttlSeconds(body, req.ctx.config.defaultDatabaseTtlSeconds, req.ctx.config.maximumDatabaseTtlSeconds);
  return json(req.ctx.databases.renew(db.id, { ttlSeconds: ttl }));
}

async function execDatabase(req: RouteRequest): Promise<Response> {
  const body = readBodySync(req);
  const db = req.ctx.databases.require(req.params.id!);
  req.ctx.auth.authorizeDatabase(requireActor(req), db.sessionId);
  const sql = requireString(body, "sql");
  if (sql.length > req.ctx.config.maxExecSqlBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "SQL exceeds the configured exec limit.", 413);
  }
  const parameters = body.parameters ?? [];
  if (!Array.isArray(parameters)) {
    throw new ApiError("INVALID_REQUEST", "Field \"parameters\" must be an array.", 400);
  }
  if (parameters.length > 100) {
    throw new ApiError("INVALID_REQUEST", "At most 100 parameters are supported.", 400);
  }
  const result = await withTimeout(req.ctx, () => db.exec(sql, parameters), req.ctx.config.execTimeoutMs);
  if (result.rows.length > req.ctx.config.maxExecRows) {
    throw new ApiError("EXEC_ROW_LIMIT", `Exec returned more than ${req.ctx.config.maxExecRows} rows.`, 400);
  }
  return json(result);
}

async function putTemplate(req: RouteRequest): Promise<Response> {
  const body = readBodySync(req);
  const fingerprint = req.params.fingerprint!;
  const template = await req.ctx.templates.getOrCreateByFingerprint({
    fingerprint,
    name: optionalString(body, "name"),
    metadata: validateMetadata(body.metadata),
    initialization: validateInitialization(body.initialization, req.ctx.config),
  });
  return json(templateDescriptor(template));
}

async function provisionTemplate(req: RouteRequest): Promise<Response> {
  const body = readBodySync(req);
  const fingerprint = requireString(body, "fingerprint");
  const template = await req.ctx.templates.createProvisioning({
    fingerprint,
    name: optionalString(body, "name"),
    metadata: validateMetadata(body.metadata),
  });
  const descriptor = templateDescriptor(template);
  const conn = template.provisioning;
  const response: Record<string, unknown> = { ...descriptor };
  if (conn) {
    const advertised = advertisedEndpoint(req.ctx.config, conn.host, conn.port);
    response.provisioningDatabase = buildConnection({
      host: advertised.host,
      port: advertised.port,
      database: conn.database,
      username: conn.username,
      password: conn.password,
    });
  }
  return created(response);
}

function listTemplates(req: RouteRequest): Response {
  const templates = req.ctx.templates.list().map((t) => templateDescriptor(t));
  return json({ templates, count: templates.length });
}

function getTemplate(req: RouteRequest): Response {
  const template = req.ctx.templates.require(req.params.id!);
  return json(templateDescriptor(template));
}

async function finalizeTemplate(req: RouteRequest): Promise<Response> {
  const template = await req.ctx.templates.finalize(req.params.id!);
  return json(templateDescriptor(template));
}

async function deleteTemplate(req: RouteRequest): Promise<Response> {
  await req.ctx.templates.destroy(req.params.id!);
  return noContent();
}

async function runGc(req: RouteRequest): Promise<Response> {
  const report = await req.ctx.daemon.runReaperOnce();
  return json({ gc: report });
}

async function shutdownDaemon(req: RouteRequest): Promise<Response> {
  // Defer the actual shutdown so the response flushes before the control
  // API server closes (server.stop(true) terminates in-flight connections).
  setTimeout(() => {
    void req.ctx.daemon.shutdown("control API request");
  }, 150);
  return json({ status: "shutting_down" });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireActor(req: RouteRequest): AuthActor {
  if (!req.actor) {
    throw new ApiError(
      "UNAUTHORIZED",
      "Authentication required. Provide a valid daemon control token (Authorization: Bearer <token>) or session lease token.",
      401,
    );
  }
  return req.actor;
}

function readBodySync(req: RouteRequest): Record<string, unknown> {
  // Body was already parsed by the server layer for POST/PUT with content.
  return (req.request as unknown as { __parsedBody?: Record<string, unknown> }).__parsedBody ?? {};
}

async function withTimeout<T>(ctx: ApiContext, fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError("EXEC_TIMEOUT", `Operation exceeded ${ms}ms.`, 408)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statusBody(ctx: ApiContext): Record<string, unknown> {
  const started = ctx.daemon.startedAt.getTime();
  return {
    name: "litegres",
    version: ctx.daemon.version,
    state: ctx.daemon.state(),
    startedAt: ctx.daemon.startedAt.toISOString(),
    uptimeSeconds: Math.round((ctx.clock.nowMs() - started) / 1000),
    activeDatabases: ctx.databases.size,
    activeTemplates: ctx.templates.size,
    activeSessions: ctx.sessions.size,
    limits: {
      maxDatabases: ctx.config.maxDatabases,
      maxTemplates: ctx.config.maxTemplates,
      maxDatabasesPerSession: ctx.config.maxDatabasesPerSession,
    },
    runtime: {
      bunVersion: Bun.version,
      pgliteVersion: pgliteVersion(),
      postgresVersion: ctx.daemon.postgresVersion ?? "unknown",
      controlUrl: ctx.daemon.controlUrl,
      localOnly: isLocalHost(ctx.config.host),
    },
  };
}

function pgliteVersion(): string {
  if (typeof __PGLITE_VERSION__ !== "undefined") return __PGLITE_VERSION__;
  // Runtime probe when running from source.
  try {
    const text = readFileSync(
      join(nodeModulesPath(), "@electric-sql", "pglite", "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(text) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function nodeModulesPath(): string {
  // In source mode node_modules sits beside the repo root; in standalone
  // mode there is none and the probe fails gracefully to "unknown".
  return join(import.meta.dir, "..", "..", "node_modules");
}

// ---------------------------------------------------------------------------
// OpenAPI document (single source of truth; docs/openapi.yaml is generated).
// ---------------------------------------------------------------------------
