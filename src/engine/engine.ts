/**
 * Engine: the seam between Litegres' control plane and whatever actually
 * hosts the databases.
 *
 * Registries and managed objects only ever hold the opaque handles defined
 * here; engine-specific objects (pg pools, ...) never leave their engine.
 *
 * The one engine is `native`: one real PostgreSQL server, one database per
 * Litegres database, templates are real databases cloned with
 * `CREATE DATABASE ... TEMPLATE`.
 */

export type EngineName = "native";

/** Everything an ordinary PostgreSQL client needs to connect. */
export interface EngineConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface ExecResult {
  fields: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
}

/** A live, disposable database. */
export interface EngineDatabase extends EngineConnection {
  readonly serverVersion?: string;
  exec(sql: string, params: unknown[]): Promise<ExecResult>;
  /**
   * Restore the database to its initial state (its template, or empty plus
   * its initialization statements) under the same name and credentials.
   * Open connections are terminated.
   */
  reset(): Promise<void>;
  /** Destroy the database and release every resource. Must be idempotent. */
  close(): Promise<void>;
}

/** Immutable template payload. Only the engine that produced it understands it. */
export interface TemplateData {
  readonly engine: EngineName;
}

/** A template being populated by external tooling (Flyway, Liquibase, ...). */
export interface ProvisioningHandle {
  readonly connection: EngineConnection;
  /** Seal the template (no more writes) and return its immutable data. */
  finalize(): Promise<TemplateData>;
  /** Discard the template. Must be idempotent. */
  abort(): Promise<void>;
}

export interface CreateEngineDatabaseOptions {
  /** The registry-assigned database id (used to derive stable, unique names). */
  id: string;
  template?: TemplateData;
  /** Raw SQL applied in order before the database is handed out. */
  statements?: string[];
}

export interface EngineInfo {
  engine: EngineName;
  /** PostgreSQL server version, once known. */
  version?: string;
}

export interface Engine {
  readonly name: EngineName;
  start(): Promise<void>;
  stop(): Promise<void>;
  describe(): EngineInfo;
  createDatabase(options: CreateEngineDatabaseOptions): Promise<EngineDatabase>;
  createTemplateFromStatements(id: string, statements: string[]): Promise<TemplateData>;
  beginProvisioning(id: string): Promise<ProvisioningHandle>;
  /** Release whatever a finalized template holds (no-op for in-memory snapshots). */
  destroyTemplateData(data: TemplateData): Promise<void>;
}
