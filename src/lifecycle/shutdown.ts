/**
 * Graceful shutdown coordination.
 *
 * Shutdown is idempotent, bounded by a global timeout, and continues closing
 * remaining resources when an individual close fails.
 */
import type { Clock } from "../clock";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import type { DatabaseRegistry } from "../registry/database-registry";
import type { SessionRegistry } from "../registry/session-registry";
import type { TemplateRegistry } from "../registry/template-registry";
import type { Reaper } from "./reaper";
import { daemonMachine, type DaemonState } from "./state-machine";

export interface ShutdownDeps {
  clock: Clock;
  databases: DatabaseRegistry;
  sessions: SessionRegistry;
  templates: TemplateRegistry;
  reaper: Reaper;
  metrics: Metrics;
  logger: Logger;
  shutdownTimeoutMs: number;
  /** Called after the control API is stopped. */
  stopControlApi: () => Promise<void>;
  /** Called after resources are closed. */
  cleanupRuntimeFiles: () => Promise<void>;
}

export class ShutdownCoordinator {
  private deps: ShutdownDeps;
  private _state: DaemonState = "STARTING";
  private shutdownPromise: Promise<void> | null = null;

  constructor(deps: ShutdownDeps) {
    this.deps = deps;
  }

  get state(): DaemonState {
    return this._state;
  }

  setState(next: DaemonState): void {
    this._state = daemonMachine.transition(this._state, next);
  }

  isShuttingDown(): boolean {
    return this._state === "DRAINING" || this._state === "STOPPING" || this._state === "STOPPED";
  }

  /** Begin graceful shutdown. Idempotent; subsequent calls share the result. */
  shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown(reason);
    return this.shutdownPromise;
  }

  private async doShutdown(reason: string): Promise<void> {
    const { logger, metrics } = this.deps;
    const started = this.deps.clock.monotonicMs();
    logger.info("daemon shutting down", { reason });
    this.setState("DRAINING");
    this.deps.reaper.stop();

    // Close everything within the global budget. Failures are logged per
    // resource and do not stop the remaining work.
    await runWithBudget(this.deps.shutdownTimeoutMs, async (remaining) => {
      await runWithin(remaining, async () => {
        await this.deps.sessions.closeAll();
        logger.info("sessions closed");
      }, "closing sessions");

      const remainingAfterSessions = this.deps.shutdownTimeoutMs - (this.deps.clock.monotonicMs() - started);
      await runWithin(remainingAfterSessions, async () => {
        await this.deps.databases.destroyAll();
        logger.info("databases closed");
      }, "closing databases");

      const remainingAfterDatabases = this.deps.shutdownTimeoutMs - (this.deps.clock.monotonicMs() - started);
      await runWithin(remainingAfterDatabases, async () => {
        await this.deps.templates.destroyAll();
        logger.info("templates closed");
      }, "closing templates");
    });

    this.setState("STOPPING");
    await this.deps.stopControlApi().catch((err) => {
      logger.error("failed to stop control API", { error: (err as Error).message });
    });
    await this.deps.cleanupRuntimeFiles().catch((err) => {
      logger.error("failed to clean runtime files", { error: (err as Error).message });
    });
    this.setState("STOPPED");
    metrics.increment("litegres_daemon_shutdowns_total");
    logger.info("daemon stopped", {
      durationMs: Math.round(this.deps.clock.monotonicMs() - started),
    });
  }
}

async function runWithBudget(ms: number, fn: (remainingMs: number) => Promise<void>): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Shutdown budget of ${ms}ms exhausted`)), ms);
  });
  await Promise.race([fn(ms), timeout]);
}

async function runWithin(ms: number, fn: () => Promise<void>, label: string): Promise<void> {
  if (ms <= 0) return;
  try {
    await fn();
  } catch (err) {
    // Individual resource failures must not stop the rest of shutdown.
    console.error(`[shutdown] ${label} failed:`, (err as Error).message);
  }
}
