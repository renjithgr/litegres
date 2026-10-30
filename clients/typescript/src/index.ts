/**
 * LitegresClient: first-party TypeScript client for the control API.
 *
 * Generic by design — no test-runner or framework lifecycle logic lives
 * here. All methods talk to the daemon's HTTP control plane.
 */
import { LitegresError, throwForResponse } from "./errors";
import { readDiscoveryFile, resolveRuntimeDir, type DiscoveryFile } from "./discovery";
import { existsSync, readFileSync } from "node:fs";

export { LitegresError } from "./errors";

// ---------------------------------------------------------------------------
// Types (mirror the control API)
// ---------------------------------------------------------------------------

export interface SessionClientInfo {
  name?: string;
  version?: string;
  pid?: number;
  framework?: string;
}

export interface Session {
  id: string;
  status: string;
  client?: SessionClientInfo;
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

export interface SessionWithLeaseToken extends Session {
  leaseToken: string;
}

export interface Connection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  postgresUrl: string;
  jdbcUrl: string;
}

export interface Database {
  id: string;
  sessionId?: string;
  templateId?: string;
  status: string;
  host: string;
  port: number;
  database: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

export interface DatabaseWithConnection extends Database {
  connection: Connection;
}

export interface Template {
  id: string;
  fingerprint?: string;
  name?: string;
  status: string;
  createdAt: string;
  lastUsedAt?: string;
  metadata: Record<string, string>;
}

export interface TemplateProvisioning extends Template {
  provisioningDatabase?: Connection;
}

export interface CreateSessionOptions {
  client?: SessionClientInfo;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}

export interface CreateDatabaseOptions {
  sessionId?: string;
  templateId?: string;
  storage?: { type: "memory" };
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  initialization?: { statements: string[] };
}

export interface CreateTemplateOptions {
  name?: string;
  fingerprint: string;
  metadata?: Record<string, string>;
  initialization?: { statements?: string[] };
}

export interface DatabaseFilter {
  sessionId?: string;
  templateId?: string;
  state?: string;
  expired?: boolean;
  application?: string;
}

export interface LitegresClientOptions {
  /** Control URL, e.g. http://127.0.0.1:49100. Defaults to discovery. */
  controlUrl?: string;
  /** Daemon control token. Defaults to the discovery token file. */
  token?: string;
  /** Runtime dir override (used when discovery is not the default location). */
  runtimeDirOverride?: string;
  /** Session lease token used as an alternative credential for scoped calls. */
  leaseToken?: string;
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LitegresClient {
  private baseUrl: string;
  private token: string | undefined;
  private leaseToken: string | undefined;
  private fetchFn: typeof fetch;
  readonly discovery: DiscoveryFile | undefined;

  private constructor(opts: LitegresClientOptions, discovery: DiscoveryFile | undefined) {
    this.baseUrl = (opts.controlUrl ?? discovery?.controlUrl ?? "http://127.0.0.1:49100").replace(/\/$/, "");
    this.token = opts.token;
    this.leaseToken = opts.leaseToken;
    this.fetchFn = opts.fetch ?? fetch;
    this.discovery = discovery;
  }

  /** Discover the daemon (default runtime dir) and connect. */
  static async connect(opts: LitegresClientOptions = {}): Promise<LitegresClient> {
    let discovery: DiscoveryFile | undefined;
    if (!opts.controlUrl) {
      const runtimeDir = resolveRuntimeDir(opts.runtimeDirOverride);
      discovery = readDiscoveryFile(runtimeDir);
      if (!discovery) {
        throw new Error(
          "No Litegres daemon discovery file found. Start the daemon with `litegresd run` or pass controlUrl.",
        );
      }
      if (!opts.token) {
        opts = { ...opts, token: readTokenFromDiscovery(runtimeDir) };
      }
    }
    const client = new LitegresClient(opts, discovery);
    await client.assertReachable();
    return client;
  }

  /** Connect to an explicit URL without discovery. */
  static connectTo(controlUrl: string, token?: string): LitegresClient {
    return new LitegresClient({ controlUrl, token }, undefined);
  }

  setLeaseToken(token: string): void {
    this.leaseToken = token;
  }

  clearLeaseToken(): void {
    this.leaseToken = undefined;
  }

  private async assertReachable(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/health/ready`);
    if (!res.ok) {
      throw new Error(`Litegres daemon at ${this.baseUrl} is not ready (HTTP ${res.status}).`);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.leaseToken) headers["x-litegres-lease-token"] = this.leaseToken;
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      await throwForResponse(res, `Litegres request failed: ${method} ${path}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // -- health / status ------------------------------------------------------

  status(): Promise<{ state: string; activeDatabases: number; [key: string]: unknown }> {
    return this.request("GET", "/v1/status");
  }

  gc(): Promise<{ gc: Record<string, unknown> }> {
    return this.request("POST", "/v1/gc");
  }

  shutdown(): Promise<{ status: string }> {
    return this.request("POST", "/v1/shutdown");
  }

  // -- sessions --------------------------------------------------------------

  createSession(options: CreateSessionOptions = {}): Promise<SessionWithLeaseToken> {
    return this.request("POST", "/v1/sessions", {
      client: options.client,
      ttlSeconds: options.ttlSeconds,
      metadata: options.metadata,
    });
  }

  getSession(sessionId: string): Promise<Session> {
    return this.request("GET", `/v1/sessions/${sessionId}`);
  }

  listSessions(): Promise<{ sessions: Session[]; count: number }> {
    return this.request("GET", "/v1/sessions");
  }

  renewSession(sessionId: string, ttlSeconds: number): Promise<Session> {
    return this.request("POST", `/v1/sessions/${sessionId}/renew`, { ttlSeconds });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/v1/sessions/${sessionId}`);
  }

  // -- databases -------------------------------------------------------------

  createDatabase(options: CreateDatabaseOptions): Promise<DatabaseWithConnection> {
    return this.request("POST", "/v1/databases", {
      sessionId: options.sessionId,
      templateId: options.templateId,
      storage: options.storage ?? { type: "memory" },
      ttlSeconds: options.ttlSeconds,
      metadata: options.metadata,
      initialization: options.initialization,
    });
  }

  getDatabase(databaseId: string): Promise<Database> {
    return this.request("GET", `/v1/databases/${databaseId}`);
  }

  listDatabases(filter: DatabaseFilter = {}): Promise<{ databases: Database[]; count: number }> {
    const params = new URLSearchParams();
    if (filter.sessionId) params.set("sessionId", filter.sessionId);
    if (filter.templateId) params.set("templateId", filter.templateId);
    if (filter.state) params.set("state", filter.state);
    if (filter.expired !== undefined) params.set("expired", String(filter.expired));
    if (filter.application) params.set("application", filter.application);
    const qs = params.toString();
    return this.request("GET", `/v1/databases${qs ? `?${qs}` : ""}`);
  }

  renewDatabase(databaseId: string, ttlSeconds: number): Promise<Database> {
    return this.request("POST", `/v1/databases/${databaseId}/renew`, { ttlSeconds });
  }

  /**
   * Restore a database to its initial state (its template, or empty plus its
   * initialization statements) under the same name and credentials. Open
   * connections are terminated. Native engine only.
   */
  resetDatabase(databaseId: string): Promise<Database> {
    return this.request("POST", `/v1/databases/${databaseId}/reset`);
  }

  async deleteDatabase(databaseId: string): Promise<void> {
    await this.request("DELETE", `/v1/databases/${databaseId}`);
  }

  exec(
    databaseId: string,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<{ fields: string[]; rows: Record<string, unknown>[]; affectedRows?: number }> {
    return this.request("POST", `/v1/databases/${databaseId}/exec`, { sql, parameters });
  }

  // -- templates -------------------------------------------------------------

  /** Create a template from statements (idempotent by fingerprint). */
  putTemplate(options: CreateTemplateOptions): Promise<Template> {
    return this.request("PUT", `/v1/templates/${encodeURIComponent(options.fingerprint)}`, {
      name: options.name,
      metadata: options.metadata,
      initialization: options.initialization,
    });
  }

  /** Start external provisioning; returns the provisioning endpoint. */
  createTemplate(options: CreateTemplateOptions): Promise<TemplateProvisioning> {
    return this.request("POST", "/v1/templates", {
      name: options.name,
      fingerprint: options.fingerprint,
      metadata: options.metadata,
    });
  }

  finalizeTemplate(templateId: string): Promise<Template> {
    return this.request("POST", `/v1/templates/${templateId}/finalize`);
  }

  getTemplate(templateId: string): Promise<Template> {
    return this.request("GET", `/v1/templates/${templateId}`);
  }

  listTemplates(): Promise<{ templates: Template[]; count: number }> {
    return this.request("GET", "/v1/templates");
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.request("DELETE", `/v1/templates/${templateId}`);
  }

  /** Convenience: provision -> (migrate via postgresUrl) -> finalize. */
  async provisionTemplate(options: CreateTemplateOptions): Promise<Template> {
    const template = await this.createTemplate(options);
    if (!template.provisioningDatabase) {
      throw new LitegresError({
        code: "TEMPLATE_NOT_READY",
        message: "Provisioning endpoint was not returned.",
        status: 409,
      });
    }
    return template;
  }
}

function readTokenFromDiscovery(runtimeDir: string): string | undefined {
  const discovery = readDiscoveryFile(runtimeDir);
  if (!discovery) return undefined;
  const tokenPath = discovery.tokenFile;
  if (!existsSync(tokenPath)) return undefined;
  try {
    return readFileSync(tokenPath, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
