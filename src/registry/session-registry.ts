/**
 * SessionRegistry: owns client sessions.
 *
 * Deleting a session destroys every database owned by that session through
 * the database registry; the operation is idempotent.
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import type { DaemonConfig } from "../config/config";
import { generateId, generateSecretToken } from "../ids";
import { sessionMachine } from "../lifecycle/state-machine";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import { ManagedSession, type SessionClientInfo } from "../sessions/managed-session";
import type { DatabaseRegistry } from "./database-registry";
import type { SessionDescriptor, SessionId } from "../types";

export interface CreateSessionOptions {
  client?: SessionClientInfo;
  ttlSeconds: number;
  metadata?: Record<string, string>;
}

export interface SessionRegistryDeps {
  config: DaemonConfig;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  databases: DatabaseRegistry;
  onClose?: (sessionId: SessionId) => void;
}

export class SessionRegistry {
  private sessions = new Map<SessionId, ManagedSession>();
  private deps: SessionRegistryDeps;

  constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: SessionId): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  require(id: SessionId): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ApiError("SESSION_NOT_FOUND", `Session ${id} was not found.`, 404, { sessionId: id });
    }
    if (!session.isActive) {
      throw new ApiError("SESSION_EXPIRED", `Session ${id} is no longer active.`, 409, {
        sessionId: id,
        state: session.state,
      });
    }
    return session;
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  create(options: CreateSessionOptions): { session: ManagedSession; expiresAt: Date } {
    const { config, clock, metrics, logger } = this.deps;
    const id = generateId("ses");
    const leaseToken = generateSecretToken("tok");
    const ttlMs = Math.min(options.ttlSeconds, config.maximumSessionTtlSeconds) * 1000;
    const createdAt = clock.now();
    const expiresAt = new Date(clock.nowMs() + ttlMs);
    const session = new ManagedSession({
      id,
      leaseToken,
      client: options.client,
      metadata: options.metadata ?? {},
      createdAt,
      expiresAt,
      clock,
    });
    this.sessions.set(id, session);
    metrics.increment("litegres_sessions_created_total");
    metrics.setGauge("litegres_active_sessions", this.sessions.size);
    logger.info("session created", { sessionId: id, ttlSeconds: options.ttlSeconds });
    return { session, expiresAt };
  }

  renew(id: SessionId, ttlSeconds: number): ManagedSession {
    const session = this.require(id);
    const ttlMs = Math.min(ttlSeconds, this.deps.config.maximumSessionTtlSeconds) * 1000;
    session.renewLease(ttlMs);
    return session;
  }

  /**
   * Close a session and destroy all databases it owns. Idempotent.
   * Returns the number of databases destroyed.
   */
  async close(id: SessionId): Promise<{ databasesDestroyed: number }> {
    const session = this.sessions.get(id);
    if (!session) return { databasesDestroyed: 0 };
    session.close(); // ACTIVE -> CLOSING -> CLOSED (idempotent)
    const databasesDestroyed = await this.deps.databases.destroyBySession(id);
    this.sessions.delete(id);
    this.deps.metrics.setGauge("litegres_active_sessions", this.sessions.size);
    this.deps.logger.info("session closed", { sessionId: id, databasesDestroyed });
    this.deps.onClose?.(id);
    return { databasesDestroyed };
  }

  /** Close every session and destroy all databases (daemon shutdown). */
  async closeAll(): Promise<number> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.close(id);
    }
    return ids.length;
  }

  /**
   * Expire a session whose lease ended (reaper): mark EXPIRED, destroy its
   * databases, remove it.
   */
  async expire(id: SessionId): Promise<{ databasesDestroyed: number }> {
    const session = this.sessions.get(id);
    if (!session) return { databasesDestroyed: 0 };
    if (session.state !== "ACTIVE") return { databasesDestroyed: 0 };
    session.setState("EXPIRED");
    this.deps.metrics.increment("litegres_sessions_expired_total");
    const databasesDestroyed = await this.deps.databases.destroyBySession(id);
    this.sessions.delete(id);
    this.deps.metrics.setGauge("litegres_active_sessions", this.sessions.size);
    this.deps.logger.info("session expired", { sessionId: id, databasesDestroyed });
    return { databasesDestroyed };
  }

  toDescriptor(session: ManagedSession): SessionDescriptor {
    return {
      id: session.id,
      status: session.state,
      client: session.client,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      metadata: session.metadata,
    };
  }
}
