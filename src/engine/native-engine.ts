/**
 * Native engine: one real PostgreSQL server hosts every Litegres database.
 *
 *  - database  = `CREATE DATABASE <prefix><id> [TEMPLATE <template db>]`
 *  - template  = a real database, sealed with `ALLOW_CONNECTIONS false`
 *  - destroy   = `DROP DATABASE ... WITH (FORCE)`
 *
 * Connections go straight to the PostgreSQL server (no proxy), so every
 * connection is a real backend with real locking, concurrency and
 * extensions. Credentials returned to clients are the admin credentials of
 * the configured server: Litegres is a test fixture, not a multi-tenant
 * service, so point it only at a disposable server.
 */
import { randomInt } from "node:crypto";
import pg from "pg";
import { ApiError } from "../api/errors";
import type { DaemonConfig } from "../config/config";
import type { Logger } from "../observability/logger";
import { startDockerPostgres, type DockerPostgres } from "./docker-postgres";
import type {
  CreateEngineDatabaseOptions,
  Engine,
  EngineConnection,
  EngineDatabase,
  EngineInfo,
  ExecResult,
  ProvisioningHandle,
  TemplateData,
} from "./engine";

export interface NativeTemplateData extends TemplateData {
  readonly engine: "native";
  /** Name of the sealed template database. */
  readonly databaseName: string;
}

export interface NativeEngineDeps {
  config: DaemonConfig;
  logger: Logger;
}

interface ServerTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Maintenance database used for CREATE/DROP DATABASE. */
  database: string;
}

/**
 * Ownership: every database name carries an 8-hex-digit owner tag, and each
 * daemon holds a session-level advisory lock on (OWNER_LOCK_NAMESPACE, tag)
 * for as long as it lives. A crashed daemon's connection dies and its lock is
 * released, so its databases become orphans; a live daemon's databases are
 * never touched by another daemon's startup sweep, even with the same prefix.
 */
const OWNER_LOCK_NAMESPACE = 0x4c474553; // "LGES"
const OWNER_TAG = /^([0-9a-f]{8})_/;

/** SQLSTATE 55006: source database is being accessed by other users. */
const OBJECT_IN_USE = "55006";
const MIN_SERVER_VERSION_NUM = 130000; // DROP DATABASE ... WITH (FORCE)

export class NativeEngine implements Engine {
  readonly name = "native" as const;
  private target!: ServerTarget;
  private pool!: pg.Pool;
  private docker: DockerPostgres | undefined;
  private version: string | undefined;
  private started = false;
  private ownerKey = 0;
  private ownerTag = "";
  private lockClient: pg.Client | undefined;

  constructor(private deps: NativeEngineDeps) {}

  async start(): Promise<void> {
    const { config, logger } = this.deps;
    let url = config.postgresUrl;
    if (!url) {
      if (!config.postgresDocker) {
        throw new ApiError(
          "INVALID_CONFIGURATION",
          "The native engine needs a PostgreSQL server: pass --postgres-url (or LITEGRES_POSTGRES_URL), or enable --postgres-docker.",
          500,
        );
      }
      this.docker = await startDockerPostgres({
        image: config.postgresImage,
        keep: config.keepPostgres,
        logger: logger.child({ component: "docker-postgres" }),
      });
      url = this.docker.url;
    }
    this.target = parseTarget(url);
    this.pool = new pg.Pool({
      host: this.target.host,
      port: this.target.port,
      user: this.target.username,
      password: this.target.password,
      database: this.target.database,
      max: 8,
      ssl: false,
    });
    // An idle pooled client erroring (server restart) must not crash the daemon.
    this.pool.on("error", (err) => logger.warn("postgres pool error", { error: err.message }));

    try {
      const res = await this.pool.query(
        "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS num",
      );
      this.version = res.rows[0].version as string;
      if ((res.rows[0].num as number) < MIN_SERVER_VERSION_NUM) {
        throw new Error(`PostgreSQL ${this.version} is too old; 13 or newer is required`);
      }
    } catch (err) {
      await this.pool.end().catch(() => {});
      await this.docker?.stop().catch(() => {});
      throw new ApiError(
        "INVALID_CONFIGURATION",
        `Cannot use PostgreSQL at ${this.target.host}:${this.target.port}: ${(err as Error).message}`,
        500,
      );
    }
    try {
      await this.claimOwnership();
    } catch (err) {
      await this.pool.end().catch(() => {});
      await this.docker?.stop().catch(() => {});
      throw new ApiError(
        "INVALID_CONFIGURATION",
        `Could not take the daemon ownership lock on PostgreSQL: ${(err as Error).message}`,
        500,
      );
    }
    this.started = true;
    const swept = await this.sweepOrphans();
    logger.info("native engine ready", {
      host: this.target.host,
      port: this.target.port,
      version: this.version,
      managedContainer: this.docker !== undefined,
      orphansDropped: swept,
    });
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.pool.end().catch(() => {});
      // Ending this connection releases the ownership lock.
      await this.lockClient?.end().catch(() => {});
      this.lockClient = undefined;
      this.started = false;
    }
    await this.docker?.stop().catch((err) => {
      this.deps.logger.warn("failed to stop managed postgres container", {
        error: (err as Error).message,
      });
    });
  }

  describe(): EngineInfo {
    return { engine: "native", version: this.version };
  }

  async createDatabase(options: CreateEngineDatabaseOptions): Promise<EngineDatabase> {
    const name = this.nameFor(options.id);
    const template = options.template as NativeTemplateData | undefined;
    await this.createDatabaseNamed(name, template?.databaseName);
    try {
      await this.runStatements(name, options.statements ?? [], "DATABASE_CREATION_FAILED", 400);
    } catch (err) {
      await this.dropDatabase(name).catch(() => {});
      throw err;
    }
    return new NativeDatabase(
      this,
      this.connectionFor(name),
      this.version,
      template?.databaseName,
      options.statements ?? [],
    );
  }

  async createTemplateFromStatements(id: string, statements: string[]): Promise<TemplateData> {
    const name = this.nameFor(id);
    try {
      await this.createDatabaseNamed(name);
      await this.runStatements(name, statements, "TEMPLATE_CREATION_FAILED", 500);
      await this.seal(name);
    } catch (err) {
      await this.dropDatabase(name).catch(() => {});
      if (err instanceof ApiError) {
        throw new ApiError("TEMPLATE_CREATION_FAILED", `Template ${id} creation failed: ${err.message}`, 500);
      }
      throw new ApiError(
        "TEMPLATE_CREATION_FAILED",
        `Template ${id} creation failed: ${(err as Error).message}`,
        500,
      );
    }
    const data: NativeTemplateData = { engine: "native", databaseName: name };
    return data;
  }

  async beginProvisioning(id: string): Promise<ProvisioningHandle> {
    const name = this.nameFor(id);
    await this.createDatabaseNamed(name);
    return {
      connection: this.connectionFor(name),
      finalize: async () => {
        await this.seal(name);
        return { engine: "native", databaseName: name } satisfies NativeTemplateData;
      },
      abort: () => this.dropDatabase(name),
    };
  }

  async destroyTemplateData(data: TemplateData): Promise<void> {
    await this.dropDatabase((data as NativeTemplateData).databaseName);
  }

  // ---- internals shared with NativeDatabase ----

  async dropDatabase(name: string): Promise<void> {
    await this.pool.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  }

  /** Drop and recreate a database from its original template/statements, same name. */
  async recreateDatabase(name: string, templateName: string | undefined, statements: string[]): Promise<void> {
    await this.dropDatabase(name);
    try {
      await this.createDatabaseNamed(name, templateName);
      await this.runStatements(name, statements, "DATABASE_CREATION_FAILED", 400);
    } catch (err) {
      await this.dropDatabase(name).catch(() => {});
      throw err;
    }
  }

  async execIn(name: string, sql: string, params: unknown[]): Promise<ExecResult> {
    const client = new pg.Client({
      host: this.target.host,
      port: this.target.port,
      user: this.target.username,
      password: this.target.password,
      database: name,
      ssl: false,
      query_timeout: this.deps.config.execTimeoutMs,
    });
    await client.connect();
    try {
      const result = await client.query(sql, params as unknown[]);
      return {
        fields: result.fields.map((f) => f.name),
        rows: result.rows as Record<string, unknown>[],
        affectedRows: result.rowCount ?? undefined,
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  private nameFor(id: string): string {
    return `${this.deps.config.namePrefix}${this.ownerTag}_${id.toLowerCase()}`;
  }

  /** Hold this daemon's ownership lock on a dedicated connection for its lifetime. */
  private async claimOwnership(): Promise<void> {
    this.ownerKey = randomInt(1, 0x7fffffff);
    this.ownerTag = this.ownerKey.toString(16).padStart(8, "0");
    const client = new pg.Client({
      host: this.target.host,
      port: this.target.port,
      user: this.target.username,
      password: this.target.password,
      database: this.target.database,
      ssl: false,
      keepAlive: true,
    });
    client.on("error", (err) =>
      this.deps.logger.warn("ownership connection lost; this daemon's databases are no longer protected from other daemons' sweeps", {
        error: err.message,
      }),
    );
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [OWNER_LOCK_NAMESPACE, this.ownerKey]);
    this.lockClient = client;
  }

  private connectionFor(name: string): EngineConnection {
    return {
      host: this.target.host,
      port: this.target.port,
      database: name,
      username: this.target.username,
      password: this.target.password,
    };
  }

  private async createDatabaseNamed(name: string, templateName?: string): Promise<void> {
    const sql = `CREATE DATABASE ${quote(name)}${templateName ? ` TEMPLATE ${quote(templateName)}` : ""}`;
    // Cloning needs the template momentarily free of other sessions; a
    // sealed template normally is, but a concurrent finalize may still be
    // terminating a backend, so retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pool.query(sql);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === OBJECT_IN_USE && attempt < 5) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  /** Make a template database immutable: refuse connections, drop existing ones. */
  private async seal(name: string): Promise<void> {
    await this.pool.query(`ALTER DATABASE ${quote(name)} WITH ALLOW_CONNECTIONS false`);
    await this.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
  }

  private async runStatements(
    dbName: string,
    statements: string[],
    code: "DATABASE_CREATION_FAILED" | "TEMPLATE_CREATION_FAILED",
    status: number,
  ): Promise<void> {
    if (statements.length === 0) return;
    const client = new pg.Client({
      host: this.target.host,
      port: this.target.port,
      user: this.target.username,
      password: this.target.password,
      database: dbName,
      ssl: false,
    });
    await client.connect();
    try {
      for (const [index, statement] of statements.entries()) {
        try {
          await client.query(statement);
        } catch (err) {
          throw new ApiError(
            code,
            `Initialization statement ${index + 1} failed: ${(err as Error).message}`,
            status,
            { statementIndex: index },
          );
        }
      }
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Drop databases whose owning daemon is gone: names with this prefix whose
   * owner tag is not backed by a live advisory lock (or that carry no tag).
   * Databases of live daemons, even ones sharing the prefix, are left alone.
   */
  private async sweepOrphans(): Promise<number> {
    const prefix = this.deps.config.namePrefix;
    const live = await this.pool.query<{ objid: number }>(
      "SELECT objid::bigint AS objid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objsubid = 2 AND granted",
      [OWNER_LOCK_NAMESPACE],
    );
    const liveKeys = new Set(live.rows.map((r) => Number(r.objid)));
    const res = await this.pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
      [prefix],
    );
    let dropped = 0;
    for (const { datname } of res.rows) {
      const match = OWNER_TAG.exec(datname.slice(prefix.length));
      if (match && liveKeys.has(parseInt(match[1]!, 16))) continue;
      try {
        await this.dropDatabase(datname);
        dropped++;
      } catch (err) {
        this.deps.logger.warn("failed to drop orphan database", {
          database: datname,
          error: (err as Error).message,
        });
      }
    }
    return dropped;
  }
}

class NativeDatabase implements EngineDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  private closePromise: Promise<void> | null = null;
  /** Serializes resets (and keeps close() from racing a reset). */
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private engine: NativeEngine,
    conn: EngineConnection,
    readonly serverVersion: string | undefined,
    private templateName: string | undefined,
    private statements: string[],
  ) {
    this.host = conn.host;
    this.port = conn.port;
    this.database = conn.database;
    this.username = conn.username;
    this.password = conn.password;
  }

  exec(sql: string, params: unknown[]): Promise<ExecResult> {
    return this.engine.execIn(this.database, sql, params);
  }

  reset(): Promise<void> {
    const run = this.busy.then(() =>
      this.engine.recreateDatabase(this.database, this.templateName, this.statements),
    );
    this.busy = run.catch(() => {});
    return run;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.busy.then(() => this.engine.dropDatabase(this.database));
    }
    return this.closePromise;
  }
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function parseTarget(raw: string): ServerTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("INVALID_CONFIGURATION", "postgresUrl is not a valid URL.", 500);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ApiError("INVALID_CONFIGURATION", "postgresUrl must start with postgres:// or postgresql://.", 500);
  }
  return {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 5432,
    username: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
  };
}
