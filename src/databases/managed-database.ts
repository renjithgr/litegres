/**
 * ManagedDatabase: one disposable database.
 *
 * Owns the engine-side database handle. Engine objects never escape the
 * engine; the API layer only ever sees descriptors and connection strings.
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import { databaseMachine, type DatabaseState } from "../lifecycle/state-machine";
import type { EngineDatabase } from "../engine/engine";
import type { DatabaseId, SessionId, TemplateId } from "../types";

export interface ManagedDatabaseInit {
  id: DatabaseId;
  sessionId?: SessionId;
  templateId?: TemplateId;
  createdAt: Date;
  expiresAt: Date;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
  metadata: Record<string, string>;
  instance: EngineDatabase;
  state: DatabaseState;
  closeTimeoutMs: number;
  clock: Clock;
}

export class ManagedDatabase {
  readonly id: DatabaseId;
  readonly sessionId?: SessionId;
  readonly templateId?: TemplateId;
  readonly createdAt: Date;
  readonly host: string;
  readonly port: number;
  readonly databaseName: string;
  readonly username: string;
  readonly metadata: Record<string, string>;
  readonly closeTimeoutMs: number;

  private _password: string;
  private _expiresAt: Date;
  private _state: DatabaseState;
  private _instance: EngineDatabase;
  private clock: Clock;
  private closePromise: Promise<void> | null = null;

  constructor(init: ManagedDatabaseInit) {
    this.id = init.id;
    this.sessionId = init.sessionId;
    this.templateId = init.templateId;
    this.createdAt = init.createdAt;
    this.host = init.host;
    this.port = init.port;
    this.databaseName = init.databaseName;
    this.username = init.username;
    this.metadata = init.metadata;
    this.closeTimeoutMs = init.closeTimeoutMs;
    this._password = init.password;
    this._expiresAt = init.expiresAt;
    this._state = init.state;
    this._instance = init.instance;
    this.clock = init.clock;
  }

  get state(): DatabaseState {
    return this._state;
  }

  get expiresAt(): Date {
    return this._expiresAt;
  }

  get password(): string {
    return this._password;
  }

  get isClosed(): boolean {
    return this._state === "CLOSED" || this._state === "FAILED" || this._state === "EXPIRED";
  }

  /** Transition the state machine; throws INVALID_STATE_TRANSITION on bad moves. */
  setState(next: DatabaseState): void {
    this._state = databaseMachine.transition(this._state, next);
  }

  /** True once the database is usable over the wire protocol. */
  isReady(): boolean {
    return this._state === "READY";
  }

  renewLease(durationMs: number): void {
    if (!this.isReady()) {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `Cannot renew database ${this.id}: current state is ${this._state}.`,
        409,
        { state: this._state },
      );
    }
    this._expiresAt = new Date(this.clock.nowMs() + durationMs);
  }

  /**
   * Close this database: destroy it in the engine, mark CLOSED.
   * Idempotent and safe to call concurrently.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.isClosed) return;
    this.setState("CLOSING");
    try {
      await withTimeout(this._instance.close(), this.closeTimeoutMs, "database close timed out");
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        "DATABASE_CLEANUP_FAILED",
        `Failed to close database ${this.id}: ${(err as Error).message}`,
        500,
      );
    }
    this.setState("CLOSED");
  }

  /** Admin SQL execution (diagnostics/provisioning only). */
  async exec(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ fields: string[]; rows: Record<string, unknown>[]; affectedRows?: number }> {
    if (!this.isReady()) {
      throw new ApiError(
        "DATABASE_NOT_READY",
        `Database ${this.id} is not ready (state: ${this._state}).`,
        409,
        { state: this._state },
      );
    }
    try {
      return await this._instance.exec(sql, params);
    } catch (err) {
      throw new ApiError(
        "EXEC_FAILED",
        `SQL execution failed: ${(err as Error).message}`,
        400,
      );
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
