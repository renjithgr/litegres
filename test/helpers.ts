/**
 * Shared test helpers: build daemons with hermetic config and connect
 * PostgreSQL clients to created databases.
 */
import { Daemon, VERSION } from "../src/daemon";
import { ManualClock, SystemClock, type Clock } from "../src/clock";
import { startDockerPostgres } from "../src/engine/docker-postgres";
import type { DaemonConfig } from "../src/config/config";
import { Logger } from "../src/observability/logger";
import { Metrics } from "../src/observability/metrics";
import pg from "pg";

/**
 * Admin URL of the disposable PostgreSQL server the tests run against.
 *
 * Set LITEGRES_TEST_POSTGRES_URL to use a server you provide (CI service
 * container, local install; it must be disposable). Otherwise the first test
 * that needs a database starts a throwaway postgres container (needs Docker)
 * and removes it when the test run ends.
 */
export function testPostgresUrl(): string {
  const url = process.env.LITEGRES_TEST_POSTGRES_URL;
  if (!url) throw new Error("No test PostgreSQL yet: await ensureTestPostgres() first");
  return url;
}

/**
 * `bun test` ends the process without running exit handlers, so a detached
 * watchdog waits for this process to disappear (however it ends) and then
 * removes the container.
 */
function removeContainerWhenThisProcessEnds(container: string): void {
  const watchdog = Bun.spawn(
    ["sh", "-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; docker rm -f ${container} >/dev/null 2>&1`],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  watchdog.unref();
}

let ensured: Promise<string> | undefined;

export function ensureTestPostgres(): Promise<string> {
  if (process.env.LITEGRES_TEST_POSTGRES_URL) return Promise.resolve(process.env.LITEGRES_TEST_POSTGRES_URL);
  ensured ??= (async () => {
    const clock = new SystemClock();
    const logger = new Logger({ level: "error", format: "json", clock, destination: () => {} });
    const pgContainer = await startDockerPostgres({ image: "postgres:17-alpine", keep: false, logger });
    if (pgContainer.owned) removeContainerWhenThisProcessEnds("litegres-postgres");
    process.env.LITEGRES_TEST_POSTGRES_URL = pgContainer.url;
    return pgContainer.url;
  })();
  return ensured;
}

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
    postgresUrl: testPostgresUrl(),
    postgresDocker: false,
    keepPostgres: false,
    postgresImage: "postgres:17-alpine",
    // Unique per daemon so concurrently live test daemons never sweep or
    // collide with each other on a shared PostgreSQL server.
    namePrefix: `litegres_test_${Math.random().toString(36).slice(2, 8)}_`,
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
  await ensureTestPostgres();
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
  // A test may leave a client open while its database is dropped (the server
  // then terminates the connection); that must not surface as an unhandled error.
  client.on("error", () => {});
  await client.connect();
  return client;
}

/** True if a client can log in to exactly this database. */
export async function canConnect(conn: PgConnection, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.username,
      password: conn.password,
      connectionTimeoutMillis: 500,
    });
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

/**
 * Wait until nobody can log in to this database any more: the endpoint's
 * database no longer exists or accepts connections
 * (native).
 */
export async function assertEndpointClosed(conn: PgConnection, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.username,
      password: conn.password,
      connectionTimeoutMillis: 300,
    });
    try {
      await client.connect();
      await client.end();
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return;
    }
  }
  throw new Error(`${conn.host}:${conn.port}/${conn.database} is still accepting connections`);
}

export { VERSION };
