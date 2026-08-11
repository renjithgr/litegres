/**
 * DatabaseRegistry: owns the set of live disposable databases.
 *
 * Responsibilities:
 *  - capacity accounting (global and per-session)
 *  - database creation orchestration (boot -> init -> socket -> readiness)
 *  - lease renewal
 *  - idempotent destruction (single, by session, all)
 *  - filtering for list endpoints
 *
 * PGlite objects never leave this module.
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import type { DaemonConfig } from "../config/config";
import { generateCredentials } from "../security/credentials";
import { generateId } from "../ids";
import { databaseMachine, type DatabaseState } from "../lifecycle/state-machine";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import { assertWireReadiness } from "../databases/readiness";
import { DatabaseFactory } from "../databases/database-factory";
import { advertisedEndpoint } from "../config/advertised";
import { ManagedDatabase } from "../databases/managed-database";
import type {
  CreateDatabaseOptions,
  DatabaseFilter,
  RenewLeaseOptions,
} from "../databases/database-options";
import type {
  DatabaseDescriptor,
  DatabaseId,
  DatabaseWithConnection,
  SessionId,
  TemplateId,
} from "../types";

export interface TemplateSnapshot {
  tarball: Blob;
  capturedAt: Date;
}

export interface DatabaseRegistryDeps {
  config: DaemonConfig;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  factory: DatabaseFactory;
  /** Callback used by the reaper/close paths; returns nothing. */
  onClose?: (id: DatabaseId) => void;
}

export class DatabaseRegistry {
  private databases = new Map<DatabaseId, ManagedDatabase>();
  private pending = new Map<DatabaseId, SessionId | undefined>();
  private deps: DatabaseRegistryDeps;
  /** Cache of the latest observed PostgreSQL server version string. */
  latestServerVersion: string | undefined;

  constructor(deps: DatabaseRegistryDeps) {
    this.deps = deps;
  }

  get config(): DaemonConfig {
    return this.deps.config;
  }

  get size(): number {
    return this.databases.size;
  }

  countBySession(sessionId: SessionId): number {
    let count = 0;
    for (const db of this.databases.values()) {
      if (db.sessionId === sessionId) count++;
    }
    for (const owner of this.pending.values()) {
      if (owner === sessionId) count++;
    }
    return count;
  }

  /** Total live or in-flight creations. */
  get activeOrPending(): number {
    return this.databases.size + this.pending.size;
  }

  get(id: DatabaseId): ManagedDatabase | undefined {
    return this.databases.get(id);
  }

  list(filter: DatabaseFilter = {}): ManagedDatabase[] {
    const now = this.deps.clock.nowMs();
    const result: ManagedDatabase[] = [];
    for (const db of this.databases.values()) {
      if (filter.sessionId !== undefined && db.sessionId !== filter.sessionId) continue;
      if (filter.templateId !== undefined && db.templateId !== filter.templateId) continue;
      if (filter.state !== undefined && db.state !== filter.state) continue;
      if (filter.expired !== undefined) {
        const isExpired = db.expiresAt.getTime() <= now;
        if (isExpired !== filter.expired) continue;
      }
      if (filter.application !== undefined) {
        if (db.metadata.application !== filter.application) continue;
      }
      result.push(db);
    }
    return result;
  }

  private checkCapacity(sessionId?: SessionId): void {
    const { config, metrics } = this.deps;
    if (this.activeOrPending >= config.maxDatabases) {
      metrics.increment("litegres_database_capacity_rejections_total");
      throw new ApiError(
        "DATABASE_CAPACITY_EXHAUSTED",
        "Litegres has reached its configured database limit.",
        429,
        { active: this.databases.size, maximum: config.maxDatabases },
      );
    }
    if (sessionId && this.countBySession(sessionId) >= config.maxDatabasesPerSession) {
      throw new ApiError(
        "DATABASE_CAPACITY_EXHAUSTED",
        `Session ${sessionId} has reached its per-session database limit.`,
        429,
        {
          sessionId,
          active: this.countBySession(sessionId),
          maximum: config.maxDatabasesPerSession,
        },
      );
    }
  }

  /**
   * Create a database. Never returns until the PostgreSQL wire endpoint has
   * passed a real-client readiness check. On any failure, every partially
   * created resource is cleaned up and DATABASE_CREATION_FAILED is thrown.
   */
  async create(
    options: CreateDatabaseOptions,
    templateSnapshot?: TemplateSnapshot,
  ): Promise<DatabaseWithConnection> {
    const { config, clock, metrics, logger } = this.deps;
    const started = clock.monotonicMs();
    this.checkCapacity(options.sessionId);

    const id = generateId("db");
    this.pending.set(id, options.sessionId);
    const credentials = generateCredentials();
    const ttlMs = Math.min(options.ttlSeconds, config.maximumDatabaseTtlSeconds) * 1000;
    const createdAt = clock.now();
    const expiresAt = new Date(clock.nowMs() + ttlMs);

    let db: ManagedDatabase | null = null;
    try {
      // Boot PGlite (empty or from template snapshot).
      let instance;
      if (templateSnapshot) {
        instance = await metrics.timed("litegres_database_clone_duration_ms", () =>
          this.deps.factory.boot({ loadDataDir: templateSnapshot.tarball }),
        );
        metrics.increment("litegres_database_clones_total");
      } else {
        instance = await metrics.timed("litegres_database_create_duration_ms", () =>
          this.deps.factory.boot(),
        );
        metrics.increment("litegres_databases_created_total");
      }
      if (instance.serverVersion) this.latestServerVersion = instance.serverVersion;

      db = new ManagedDatabase({
        id,
        sessionId: options.sessionId,
        templateId: options.templateId,
        createdAt,
        expiresAt,
        host: config.host,
        port: instance.port,
        databaseName: "postgres",
        username: credentials.username,
        password: credentials.password,
        metadata: options.metadata ?? {},
        pglite: instance.pglite,
        socketServer: instance.socketServer,
        state: "CREATING",
        closeTimeoutMs: config.databaseCloseTimeoutMs,
        clock,
      });
      db.setState("INITIALIZING");

      await this.deps.factory.applyInitialization(instance.pglite, options.initialization);

      // Prove the endpoint is usable by an external PostgreSQL client.
      await assertWireReadiness(
        {
          host: db.host,
          port: db.port,
          database: db.databaseName,
          username: db.username,
          password: db.password,
        },
        config.controlApiReadinessTimeoutMs,
        { databaseId: id, host: db.host, port: db.port },
      );

      db.setState("READY");
      this.databases.set(id, db);
      metrics.setGauge("litegres_active_databases", this.databases.size);
      logger.info("database created", {
        databaseId: id,
        sessionId: options.sessionId,
        templateId: options.templateId,
        port: db.port,
        durationMs: Math.round(clock.monotonicMs() - started),
        cloned: templateSnapshot !== undefined,
      });
      return this.toDescriptorWithConnection(db);
    } catch (err) {
      metrics.increment("litegres_databases_failed_total");
      logger.warn("database creation failed", {
        databaseId: id,
        sessionId: options.sessionId,
        errorCode: err instanceof ApiError ? err.code : "INTERNAL_ERROR",
        durationMs: Math.round(clock.monotonicMs() - started),
      });
      if (db) {
        // Best-effort cleanup of the partially created instance.
        await db.close().catch((closeErr) => {
          logger.warn("cleanup of failed database failed", {
            databaseId: id,
            error: (closeErr as Error).message,
          });
        });
      }
      if (err instanceof ApiError && err.code !== "DATABASE_CREATION_FAILED") {
        throw err;
      }
      throw new ApiError(
        "DATABASE_CREATION_FAILED",
        `Database ${id} could not be created: ${(err as Error).message}`,
        500,
      );
    } finally {
      this.pending.delete(id);
    }
  }

  renew(id: DatabaseId, options: RenewLeaseOptions): DatabaseDescriptor {
    const db = this.require(id);
    const ttlMs = Math.min(options.ttlSeconds, this.config.maximumDatabaseTtlSeconds) * 1000;
    db.renewLease(ttlMs);
    return this.toDescriptor(db);
  }

  /**
   * Destroy a database. Idempotent: destroying an absent or already-closed
   * database is a no-op. If graceful shutdown fails, the failure is logged
   * and the database is still removed from the active registry.
   */
  async destroy(id: DatabaseId): Promise<void> {
    const db = this.databases.get(id);
    if (!db) return; // idempotent
    await this.destroyManaged(db);
  }

  private async destroyManaged(db: ManagedDatabase): Promise<void> {
    const { metrics, logger } = this.deps;
    const started = this.deps.clock.monotonicMs();
    this.databases.delete(db.id);
    try {
      await db.close();
      metrics.observe("litegres_database_close_duration_ms", this.deps.clock.monotonicMs() - started);
      metrics.increment("litegres_databases_destroyed_total");
    } catch (err) {
      metrics.increment("litegres_database_close_failures_total");
      logger.error("database close failed", {
        databaseId: db.id,
        errorCode: err instanceof ApiError ? err.code : "DATABASE_CLEANUP_FAILED",
        error: (err as Error).message,
      });
    } finally {
      metrics.setGauge("litegres_active_databases", this.databases.size);
    }
    this.deps.onClose?.(db.id);
  }

  /** Destroy all databases owned by a session. Returns the count destroyed. */
  async destroyBySession(sessionId: SessionId): Promise<number> {
    const owned = this.list({ sessionId });
    for (const db of owned) {
      await this.destroyManaged(db);
    }
    return owned.length;
  }

  /** Destroy every database. Returns the count destroyed. */
  async destroyAll(): Promise<number> {
    const all = [...this.databases.values()];
    for (const db of all) {
      await this.destroyManaged(db);
    }
    return all.length;
  }

  /** Mark an expired database EXPIRED and close it (reaper). Returns true if handled. */
  async expire(id: DatabaseId): Promise<boolean> {
    const db = this.databases.get(id);
    if (!db) return false;
    if (db.state !== "READY") return false;
    db.setState("EXPIRED");
    this.deps.metrics.increment("litegres_databases_expired_total");
    await this.destroyManaged(db);
    return true;
  }

  require(id: DatabaseId): ManagedDatabase {
    const db = this.databases.get(id);
    if (!db) {
      throw new ApiError("DATABASE_NOT_FOUND", `Database ${id} was not found.`, 404, { databaseId: id });
    }
    return db;
  }

  toDescriptor(db: ManagedDatabase): DatabaseDescriptor {
    const advertised = advertisedEndpoint(this.config, db.host, db.port);
    return {
      id: db.id,
      sessionId: db.sessionId,
      templateId: db.templateId,
      status: db.state.toLowerCase(),
      host: advertised.host,
      port: advertised.port,
      database: db.databaseName,
      username: db.username,
      createdAt: db.createdAt.toISOString(),
      expiresAt: db.expiresAt.toISOString(),
      metadata: db.metadata,
    };
  }

  private toDescriptorWithConnection(db: ManagedDatabase): DatabaseWithConnection {
    const descriptor = this.toDescriptor(db);
    const password = db.password;
    const encoded = encodeURIComponent(password);
    return {
      ...descriptor,
      connection: {
        host: descriptor.host,
        port: descriptor.port,
        database: db.databaseName,
        username: db.username,
        password,
        postgresUrl: `postgresql://${db.username}:${encoded}@${descriptor.host}:${descriptor.port}/${db.databaseName}`,
        jdbcUrl: `jdbc:postgresql://${descriptor.host}:${descriptor.port}/${db.databaseName}?sslmode=disable`,
      },
    };
  }

  stateOf(id: DatabaseId): DatabaseState | undefined {
    return this.databases.get(id)?.state;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
