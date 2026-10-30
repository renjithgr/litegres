/**
 * Litegres daemon: one long-lived process managing many isolated disposable
 * databases, hosted by a pluggable engine (native PostgreSQL or PGlite).
 *
 * Wires together configuration, registries, the reaper, the control API,
 * discovery files and graceful shutdown. Exposes a narrow Daemon interface to
 * the API layer.
 */
import { ApiError } from "./api/errors";
import { ApiServer } from "./api/server";
import type { ApiContext } from "./api/routes";
import { SystemClock, type Clock } from "./clock";
import { loadConfig, type DaemonConfig } from "./config/config";
import type { Engine } from "./engine/engine";
import { NativeEngine } from "./engine/native-engine";
import { PgliteEngine } from "./engine/pglite-engine";
import { DatabaseRegistry } from "./registry/database-registry";
import { SessionRegistry } from "./registry/session-registry";
import { TemplateRegistry } from "./registry/template-registry";
import { Reaper } from "./lifecycle/reaper";
import { ShutdownCoordinator } from "./lifecycle/shutdown";
import { Logger } from "./observability/logger";
import { Metrics } from "./observability/metrics";
import { AuthManager } from "./security/auth";
import { RuntimeDirectory, type DiscoveryFile } from "./security/runtime-directory";
import { generateSecretToken } from "./ids";
import type { DaemonState } from "./lifecycle/state-machine";
import type { ReaperReport } from "./lifecycle/reaper";

export const VERSION = "0.1.0";

export interface DaemonOptions {
  config?: DaemonConfig;
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /** Skip runtime-dir locking/discovery (used by tests). */
  noRuntimeDir?: boolean;
  /** Custom runtime dir override. */
  runtimeDirOverride?: string;
}

export class Daemon {
  readonly config: DaemonConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly databases: DatabaseRegistry;
  readonly sessions: SessionRegistry;
  readonly templates: TemplateRegistry;
  readonly reaper: Reaper;
  readonly auth: AuthManager;
  readonly runtimeDir: RuntimeDirectory | null;
  readonly startedAt: Date;
  readonly engine: Engine;

  private apiServer: ApiServer | null = null;
  readonly controlToken: string;
  private postgresVersion: string | undefined;
  private signalHandlersInstalled = false;
  private shutdownCoordinator: ShutdownCoordinator;

  constructor(opts: DaemonOptions = {}) {
    this.config = opts.config ?? loadConfig({});
    this.clock = opts.clock ?? new SystemClock();
    this.logger = opts.logger ?? new Logger({ level: this.config.logLevel, format: this.config.logFormat, clock: this.clock });
    this.metrics = opts.metrics ?? new Metrics();
    this.startedAt = this.clock.now();

    this.engine =
      this.config.engine === "pglite"
        ? new PgliteEngine({ config: this.config, clock: this.clock, metrics: this.metrics })
        : new NativeEngine({ config: this.config, logger: this.logger.child({ component: "engine" }) });
    this.databases = new DatabaseRegistry({
      config: this.config,
      clock: this.clock,
      metrics: this.metrics,
      logger: this.logger.child({ component: "databases" }),
      engine: this.engine,
    });
    this.sessions = new SessionRegistry({
      config: this.config,
      clock: this.clock,
      metrics: this.metrics,
      logger: this.logger.child({ component: "sessions" }),
      databases: this.databases,
    });
    this.templates = new TemplateRegistry({
      config: this.config,
      clock: this.clock,
      metrics: this.metrics,
      logger: this.logger.child({ component: "templates" }),
      engine: this.engine,
      databases: this.databases,
    });

    this.controlToken = this.config.controlToken ?? generateSecretToken("tok");
    this.auth = new AuthManager(this.controlToken, this.sessions);

    this.reaper = new Reaper({
      clock: this.clock,
      databases: this.databases,
      sessions: this.sessions,
      templates: this.templates,
      metrics: this.metrics,
      logger: this.logger.child({ component: "reaper" }),
    });

    this.runtimeDir = opts.noRuntimeDir
      ? null
      : new RuntimeDirectory({
          runtimeDirOverride: opts.runtimeDirOverride ?? this.config.runtimeDir,
          logger: this.logger.child({ component: "runtime" }),
          version: VERSION,
        });

    this.shutdownCoordinator = new ShutdownCoordinator({
      clock: this.clock,
      databases: this.databases,
      sessions: this.sessions,
      templates: this.templates,
      reaper: this.reaper,
      metrics: this.metrics,
      logger: this.logger.child({ component: "shutdown" }),
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      stopEngine: () => this.engine.stop(),
      stopControlApi: () => this.apiServer?.stop() ?? Promise.resolve(),
      cleanupRuntimeFiles: () => this.runtimeDir?.removeAll() ?? Promise.resolve(),
    });
  }

  get state(): DaemonState {
    return this.shutdownCoordinator.state;
  }

  get controlUrl(): string {
    return `http://${this.config.host}:${this.apiServer?.actualPort ?? this.config.port}`;
  }

  setState(next: DaemonState): void {
    this.shutdownCoordinator.setState(next);
  }

  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;
    const onSignal = (signal: string) => {
      this.logger.info("signal received", { signal });
      void this.shutdown(`signal ${signal}`);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
  }

  /** The ApiContext consumed by the control plane. */
  private apiContext(): ApiContext {
    return {
      config: this.config,
      clock: this.clock,
      logger: this.logger.child({ component: "api" }),
      metrics: this.metrics,
      databases: this.databases,
      sessions: this.sessions,
      templates: this.templates,
      auth: this.auth,
      daemon: {
        state: () => this.state,
        startedAt: this.startedAt,
        version: VERSION,
        controlUrl: this.controlUrl,
        postgresVersion: this.engine.describe().version ?? this.postgresVersion,
        engine: this.engine.name,
        shutdown: (reason: string) => this.shutdown(reason),
        runReaperOnce: () => this.reaper.runOnce(),
      },
    };
  }

  /**
   * Start the daemon: lock the runtime directory, start the control API,
   * write the discovery file, start the reaper, mark READY.
   */
  async start(): Promise<void> {
    this.setState("STARTING");
    try {
      if (this.runtimeDir) {
        await this.runtimeDir.acquireLock();
        await this.runtimeDir.writeTokenFile(this.controlToken);
      }

      await this.engine.start();

      const apiServer = new ApiServer({
        ctx: this.apiContext(),
        logger: this.logger.child({ component: "api" }),
        metrics: this.metrics,
        hostname: this.config.host,
        port: this.config.port,
      });
      await apiServer.start();
      this.apiServer = apiServer;

      if (this.runtimeDir) {
        const discovery: DiscoveryFile = {
          pid: process.pid,
          version: VERSION,
          controlUrl: this.controlUrl,
          tokenFile: this.runtimeDir.tokenFilePath,
          startedAt: this.startedAt.toISOString(),
        };
        await this.runtimeDir.writeDiscoveryFile(discovery);
      }

      this.reaper.start();
      this.setState("READY");
      this.installSignalHandlers();
      this.metrics.setGauge("litegres_active_databases", 0);
      this.metrics.setGauge("litegres_active_templates", 0);
      this.metrics.setGauge("litegres_active_sessions", 0);
      this.logger.info("litegres daemon ready", {
        version: VERSION,
        pid: process.pid,
        controlUrl: this.controlUrl,
        runtimeDir: this.runtimeDir?.root,
        limits: {
          maxDatabases: this.config.maxDatabases,
          maxTemplates: this.config.maxTemplates,
        },
      });
    } catch (err) {
      this.setState("FAILED");
      await this.engine.stop().catch(() => {});
      await this.runtimeDir?.removeAll().catch(() => {});
      this.logger.error("daemon failed to start", {
        errorCode: err instanceof ApiError ? err.code : "INTERNAL_ERROR",
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /** Idempotent graceful shutdown. */
  shutdown(reason: string): Promise<void> {
    return this.shutdownCoordinator.shutdown(reason);
  }

  isShuttingDown(): boolean {
    return this.shutdownCoordinator.isShuttingDown();
  }
}
