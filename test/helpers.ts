/**
 * Shared test helpers: build daemons with hermetic config and connect
 * PostgreSQL clients to created databases.
 */
import { Daemon, VERSION } from "../src/daemon";
import { ManualClock, type Clock } from "../src/clock";
import type { DaemonConfig } from "../src/config/config";
import { Logger } from "../src/observability/logger";
import { Metrics } from "../src/observability/metrics";
import pg from "pg";

export function testConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    maxDatabases: 32,
    maxTemplates: 8,
    maxDatabasesPerSession: 16,
    defaultDatabaseTtlSeconds: 600,
    maximumDatabaseTtlSeconds: 3600,
    defaultSessionTtlSeconds: 1800,
    maximumSessionTtlSeconds: 14400,
    reaperIntervalSeconds: 60,
    maxInitStatements: 100,
    maxInitPayloadBytes: 1_048_576,
    maxExecSqlBytes: 1_048_576,
    maxExecRows: 1000,
    execTimeoutMs: 5000,
    databaseCloseTimeoutMs: 10_000,
    shutdownTimeoutMs: 15_000,
    controlApiReadinessTimeoutMs: 10_000,
    logLevel: "error",
    logFormat: "json",
    rejectNonLocalBind: true,
    initialMemoryBytes: 128 * 1024 * 1024,
    dataPlanePortBase: 49152,
    dataPlanePortCount: 0,
    ...overrides,
  };
}

export interface TestDaemon {
  daemon: Daemon;
  baseUrl: string;
  headers: Record<string, string>;
  token: string;
  clock: Clock;
  close(): Promise<void>;
}

export async function startTestDaemon(opts: {
  config?: Partial<DaemonConfig>;
  clock?: Clock;
  silent?: boolean;
} = {}): Promise<TestDaemon> {
  const clock = opts.clock ?? new ManualClock(Date.now());
  const daemon = new Daemon({
    config: testConfig(opts.config),
    clock,
    logger: opts.silent === false
      ? new Logger({ level: "debug", format: "human", clock })
      : new Logger({ level: "error", format: "json", clock, destination: () => {} }),
    metrics: new Metrics(),
    noRuntimeDir: true,
  });
  await daemon.start();
  const token = daemon.controlToken;
  return {
    daemon,
    baseUrl: daemon.controlUrl,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    token,
    clock,
    async close() {
      if (daemon.state !== "STOPPED" && daemon.state !== "FAILED") {
        await daemon.shutdown("test teardown");
      }
    },
  };
}

export async function api<T>(t: TestDaemon, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: t.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
}

export async function connectPg(conn: PgConnection): Promise<pg.Client> {
  const client = new pg.Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

export async function tryConnect(port: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      await client.end();
      return true;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

export async function assertPortClosed(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", connectionTimeoutMillis: 300 });
    try {
      await client.connect();
      await client.end();
      // still open
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return;
    }
  }
  throw new Error(`Port ${port} is still accepting connections`);
}

export { VERSION };
