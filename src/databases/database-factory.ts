/**
 * DatabaseFactory: boots PGlite instances and their socket servers.
 *
 * This is the only place in the daemon that constructs PGlite instances and
 * PGLiteSocketServers. The registries and API layer never touch those types
 * directly.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import type { DaemonConfig } from "../config/config";
import type { Metrics } from "../observability/metrics";
import { createPglite } from "../packaging/pglite-assets";
import type { DatabaseInitialization } from "./database-options";

export interface BootedInstance {
  pglite: PGlite;
  socketServer: PGLiteSocketServer;
  port: number;
  serverVersion?: string;
}

export interface DatabaseFactoryDeps {
  config: DaemonConfig;
  clock: Clock;
  metrics: Metrics;
}

export class DatabaseFactory {
  constructor(private deps: DatabaseFactoryDeps) {}

  // Round-robin cursor for fixed-range port allocation (module-wide so
  // concurrent boots spread across the range).
  private static dataPlaneNextIndex = 0;

  /**
   * Boot a fresh PGlite instance and bind a socket server to an
   * OS-assigned port (port 0). Optionally seed from a template snapshot.
   */
  async boot(opts: { loadDataDir?: Blob } = {}): Promise<BootedInstance> {
    const { config, clock } = this.deps;
    let pglite: PGlite;
    try {
      pglite = await this.deps.metrics.timed("litegres_database_boot_duration_ms", () =>
        createPglite({
          loadDataDir: opts.loadDataDir,
          initialMemoryBytes: config.initialMemoryBytes,
        }),
      );
    } catch (err) {
      throw new ApiError(
        "PGLITE_STARTUP_FAILED",
        `PGlite instance failed to start: ${(err as Error).message}`,
        500,
      );
    }
    await pglite.waitReady;

    let serverVersion: string | undefined;
    try {
      const v = await pglite.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      serverVersion = v.rows[0]?.version;
    } catch {
      // version is informational only
    }

    let socketServer: PGLiteSocketServer;
    let port: number;
    try {
      const bound = await this.bindSocketServer(pglite);
      socketServer = bound.socketServer;
      port = bound.port;
    } catch (err) {
      await pglite.close().catch(() => {});
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        "SOCKET_SERVER_STARTUP_FAILED",
        `Failed to start PostgreSQL socket server: ${(err as Error).message}`,
        500,
      );
    }

    void clock;
    return { pglite, socketServer, port, serverVersion };
  }

  /**
   * Bind the socket server, honoring the fixed data-plane port range.
   *
   * With `dataPlanePortCount === 0` (the default) the OS assigns a free
   * port. With a positive count, ports are taken round-robin from
   * [dataPlanePortBase, dataPlanePortBase + dataPlanePortCount); if a port
   * is taken (concurrent creations, a previous daemon) the next one in the
   * range is tried. This is what makes Docker port publishing possible:
   * every database lives on a predictable in-container port.
   */
  private async bindSocketServer(pglite: PGlite): Promise<{ socketServer: PGLiteSocketServer; port: number }> {
    const { config } = this.deps;
    if (config.dataPlanePortCount <= 0) {
      const socketServer = new PGLiteSocketServer({
        db: pglite,
        port: 0,
        host: config.host,
        maxConnections: 8,
      });
      await socketServer.start();
      const port = parsePort(socketServer.getServerConn());
      if (!port) {
        throw new Error("OS assigned port could not be determined");
      }
      return { socketServer, port };
    }

    const { dataPlanePortBase: base, dataPlanePortCount: count } = config;
    // Round-robin start index spreads concurrent creations across the range.
    const start = base + (DatabaseFactory.dataPlaneNextIndex++ % count);
    let lastError: unknown;
    for (let i = 0; i < count; i++) {
      const candidate = base + ((start - base + i) % count);
      const socketServer = new PGLiteSocketServer({
        db: pglite,
        port: candidate,
        host: config.host,
        maxConnections: 8,
      });
      try {
        await socketServer.start();
        return { socketServer, port: candidate };
      } catch (err) {
        lastError = err;
        // Bind failed (e.g. EADDRINUSE); the server never started listening,
        // so there is nothing to close. Try the next port in the range.
      }
    }
    throw new ApiError(
      "DATA_PLANE_PORTS_EXHAUSTED",
      `All ${count} data-plane ports in [${base}, ${base + count - 1}] are in use. Increase --data-plane-port-count or free up databases. (last error: ${(lastError as Error)?.message ?? String(lastError)})`,
      429,
      { portBase: base, portCount: count },
    );
  }

  /** Apply initialization statements in order to a fresh instance. */
  async applyInitialization(
    pglite: PGlite,
    init: DatabaseInitialization | undefined,
  ): Promise<void> {
    const statements = init?.statements ?? [];
    for (const [index, statement] of statements.entries()) {
      try {
        await pglite.exec(statement);
      } catch (err) {
        throw new ApiError(
          "DATABASE_CREATION_FAILED",
          `Initialization statement ${index + 1} failed: ${(err as Error).message}`,
          400,
          { statementIndex: index },
        );
      }
    }
  }
}

export function parsePort(serverConn: string): number {
  const idx = serverConn.lastIndexOf(":");
  if (idx === -1) return 0;
  return Number(serverConn.slice(idx + 1));
}
