/**
 * PGlite engine: one WASM PostgreSQL instance plus socket server per
 * database. Wraps the existing DatabaseFactory / TemplateFactory.
 *
 * Kept behind `--engine pglite` for in-process, Docker-free use; Phase 0
 * measurements showed it is slower and far heavier than the native engine
 * and serializes all connections of a database (see docs/compatibility.md).
 */
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import type { DaemonConfig } from "../config/config";
import { DatabaseFactory } from "../databases/database-factory";
import type { Metrics } from "../observability/metrics";
import { snapshotPglite } from "../packaging/pglite-assets";
import { generateCredentials } from "../security/credentials";
import { TemplateFactory } from "../templates/template-factory";
import type {
  CreateEngineDatabaseOptions,
  Engine,
  EngineDatabase,
  EngineInfo,
  ExecResult,
  ProvisioningHandle,
  TemplateData,
} from "./engine";

export interface PgliteTemplateData extends TemplateData {
  readonly engine: "pglite";
  readonly tarball: Blob;
}

export interface PgliteEngineDeps {
  config: DaemonConfig;
  clock: Clock;
  metrics: Metrics;
}

export class PgliteEngine implements Engine {
  readonly name = "pglite" as const;
  private factory: DatabaseFactory;
  private templateFactory: TemplateFactory;
  private version: string | undefined;

  constructor(private deps: PgliteEngineDeps) {
    this.factory = new DatabaseFactory(deps);
    this.templateFactory = new TemplateFactory({
      config: deps.config,
      metrics: deps.metrics,
      databaseFactory: this.factory,
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  describe(): EngineInfo {
    return { engine: "pglite", version: this.version };
  }

  async createDatabase(options: CreateEngineDatabaseOptions): Promise<EngineDatabase> {
    const template = options.template as PgliteTemplateData | undefined;
    const booted = await this.factory.boot({ loadDataDir: template?.tarball });
    if (booted.serverVersion) this.version = booted.serverVersion;
    const credentials = generateCredentials();
    const db = new PgliteDatabase(
      {
        host: this.deps.config.host,
        port: booted.port,
        database: "postgres",
        username: credentials.username,
        password: credentials.password,
      },
      booted.pglite,
      booted.socketServer,
      booted.serverVersion,
      this.deps.config.databaseCloseTimeoutMs,
    );
    try {
      await this.factory.applyInitialization(booted.pglite, { statements: options.statements });
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
    return db;
  }

  async createTemplateFromStatements(id: string, statements: string[]): Promise<TemplateData> {
    const tarball = await this.templateFactory.createFromStatements(statements, { templateId: id });
    const data: PgliteTemplateData = { engine: "pglite", tarball };
    return data;
  }

  async beginProvisioning(_id: string): Promise<ProvisioningHandle> {
    const booted = await this.factory.boot();
    const credentials = generateCredentials();
    const db = new PgliteDatabase(
      {
        host: this.deps.config.host,
        port: booted.port,
        database: "postgres",
        username: credentials.username,
        password: credentials.password,
      },
      booted.pglite,
      booted.socketServer,
      booted.serverVersion,
      this.deps.config.databaseCloseTimeoutMs,
    );
    return {
      connection: db,
      finalize: async () => {
        const tarball = await snapshotPglite(booted.pglite);
        await db.close();
        return { engine: "pglite", tarball } satisfies PgliteTemplateData;
      },
      abort: () => db.close(),
    };
  }

  async destroyTemplateData(): Promise<void> {}
}

class PgliteDatabase implements EngineDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  private pglite: PGlite | null;
  private socketServer: PGLiteSocketServer | null;
  private closePromise: Promise<void> | null = null;

  constructor(
    conn: { host: string; port: number; database: string; username: string; password: string },
    pglite: PGlite,
    socketServer: PGLiteSocketServer,
    readonly serverVersion: string | undefined,
    private closeTimeoutMs: number,
  ) {
    this.host = conn.host;
    this.port = conn.port;
    this.database = conn.database;
    this.username = conn.username;
    this.password = conn.password;
    this.pglite = pglite;
    this.socketServer = socketServer;
  }

  async exec(sql: string, params: unknown[]): Promise<ExecResult> {
    if (!this.pglite) {
      throw new ApiError("DATABASE_NOT_READY", "Database is closed.", 409);
    }
    const result = await this.pglite.query(sql, params);
    return {
      fields: result.fields.map((f) => f.name),
      rows: result.rows as Record<string, unknown>[],
      affectedRows: result.affectedRows,
    };
  }

  async reset(): Promise<void> {
    throw new ApiError(
      "RESET_NOT_SUPPORTED",
      "The pglite engine cannot reset a database in place; use the native engine (docs/engines.md).",
      501,
    );
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    const pglite = this.pglite;
    const socketServer = this.socketServer;
    if (socketServer) {
      try {
        await withTimeout(socketServer.stop(), this.closeTimeoutMs, "socket server stop timed out");
      } catch (err) {
        throw new ApiError(
          "DATABASE_CLEANUP_FAILED",
          `Failed to stop socket server: ${(err as Error).message}`,
          500,
        );
      } finally {
        this.socketServer = null;
      }
    }
    if (pglite) {
      try {
        await withTimeout(pglite.close(), this.closeTimeoutMs, "pglite close timed out");
      } catch (err) {
        throw new ApiError(
          "DATABASE_CLEANUP_FAILED",
          `Failed to close PGlite instance: ${(err as Error).message}`,
          500,
        );
      } finally {
        this.pglite = null;
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
