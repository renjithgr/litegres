/**
 * Response serialization helpers.
 *
 * The rule: connection credentials (passwords, URLs) appear only in
 * single-resource create responses and the provisioning response. List and
 * get responses never include passwords, tokens, or URLs with credentials.
 */
import type { ManagedDatabase } from "../databases/managed-database";
import type { ManagedSession } from "../sessions/managed-session";
import type { ManagedTemplate } from "../templates/managed-template";
import type {
  DatabaseConnection,
  DatabaseDescriptor,
  SessionDescriptor,
  TemplateDescriptor,
} from "../types";
import type { DaemonConfig } from "../config/config";
import { advertisedEndpoint } from "../config/advertised";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function created(body: unknown): Response {
  return json(body, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function buildConnection(opts: {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}): DatabaseConnection {
  const encoded = encodeURIComponent(opts.password);
  return {
    host: opts.host,
    port: opts.port,
    database: opts.database,
    username: opts.username,
    password: opts.password,
    postgresUrl: `postgresql://${opts.username}:${encoded}@${opts.host}:${opts.port}/${opts.database}`,
    jdbcUrl: `jdbc:postgresql://${opts.host}:${opts.port}/${opts.database}?sslmode=disable`,
  };
}

export function databaseDescriptor(db: ManagedDatabase, config: Pick<DaemonConfig, "publicHost" | "publicPort">): DatabaseDescriptor {
  const advertised = advertisedEndpoint(config, db.host, db.port);
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

export function sessionDescriptor(session: ManagedSession): SessionDescriptor {
  return {
    id: session.id,
    status: session.state.toLowerCase(),
    client: session.client,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    metadata: session.metadata,
  };
}

export function templateDescriptor(template: ManagedTemplate): TemplateDescriptor {
  return {
    id: template.id,
    fingerprint: template.fingerprint,
    name: template.name,
    status: template.state.toLowerCase(),
    createdAt: template.createdAt.toISOString(),
    lastUsedAt: template.lastUsedAt?.toISOString(),
    metadata: template.metadata,
  };
}
