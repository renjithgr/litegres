/**
 * Shared identifier and descriptor types.
 */
export type DatabaseId = string;
export type TemplateId = string;
export type SessionId = string;

/** Stable descriptor for a database — never contains secrets. */
export interface DatabaseDescriptor {
  id: DatabaseId;
  sessionId?: SessionId;
  templateId?: TemplateId;
  status: string;
  host: string;
  port: number;
  database: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

/** Connection details including the generated password. */
export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  postgresUrl: string;
  jdbcUrl: string;
}

/** Full creation response: descriptor + credentials (returned exactly once). */
export interface DatabaseWithConnection extends DatabaseDescriptor {
  connection: DatabaseConnection;
}

export interface SessionDescriptor {
  id: SessionId;
  status: string;
  client?: { name?: string; version?: string; pid?: number; framework?: string };
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

export interface TemplateDescriptor {
  id: TemplateId;
  fingerprint?: string;
  name?: string;
  status: string;
  createdAt: string;
  lastUsedAt?: string;
  metadata: Record<string, string>;
}
