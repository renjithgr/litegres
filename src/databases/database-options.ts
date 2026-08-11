/**
 * Options accepted by the database registry when creating a database.
 */
import type { DatabaseId, SessionId, TemplateId } from "../types";

export interface DatabaseStorageOptions {
  /** Only in-memory storage is supported in the MVP. */
  type: "memory";
}

export interface DatabaseInitialization {
  /**
   * Raw SQL statements executed in order against the fresh instance,
   * before the PostgreSQL endpoint starts accepting clients.
   */
  statements?: string[];
}

export interface CreateDatabaseOptions {
  sessionId?: SessionId;
  templateId?: TemplateId;
  storage?: DatabaseStorageOptions;
  /** Requested TTL in seconds; the caller clamps it to config limits. */
  ttlSeconds: number;
  metadata?: Record<string, string>;
  initialization?: DatabaseInitialization;
}

export interface RenewLeaseOptions {
  ttlSeconds: number;
}

export interface DatabaseFilter {
  sessionId?: SessionId;
  templateId?: TemplateId;
  state?: string;
  expired?: boolean;
  application?: string;
}
