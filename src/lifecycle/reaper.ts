/**
 * Reaper: background lease/cleanup loop.
 *
 * On each pass it:
 *  - expires databases whose leases ended
 *  - expires sessions whose leases ended and destroys their databases
 *  - removes failed or abandoned template instances (READY templates are
 *    retained as immutable snapshots)
 *  - never closes an instance twice
 *  - keeps operating when a single cleanup fails (recorded in diagnostics)
 */
import type { Clock } from "../clock";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import type { DatabaseRegistry } from "../registry/database-registry";
import type { SessionRegistry } from "../registry/session-registry";
import type { TemplateRegistry } from "../registry/template-registry";

export interface ReaperReport {
  databasesExpired: number;
  sessionsExpired: number;
  databasesDestroyedForSessions: number;
  templatesReaped: number;
  failures: number;
}

export interface ReaperDeps {
  clock: Clock;
  databases: DatabaseRegistry;
  sessions: SessionRegistry;
  templates: TemplateRegistry;
  metrics: Metrics;
  logger: Logger;
  /** Override interval for tests (defaults to config). */
  intervalMs?: number;
}

export class Reaper {
  private deps: ReaperDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: ReaperDeps) {
    this.deps = deps;
  }

  get intervalMs(): number {
    return this.deps.intervalMs ?? this.deps.databases.config.reaperIntervalSeconds * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one reaper pass. Safe to call concurrently with other passes. */
  async runOnce(): Promise<ReaperReport> {
    if (this.running) return { databasesExpired: 0, sessionsExpired: 0, databasesDestroyedForSessions: 0, templatesReaped: 0, failures: 0 };
    this.running = true;
    const report: ReaperReport = {
      databasesExpired: 0,
      sessionsExpired: 0,
      databasesDestroyedForSessions: 0,
      templatesReaped: 0,
      failures: 0,
    };
    const now = this.deps.clock.nowMs();
    try {
      // 1. Expire databases whose leases ended.
      for (const db of this.deps.databases.list({ expired: true })) {
        if (db.state !== "READY") continue;
        try {
          if (await this.deps.databases.expire(db.id)) report.databasesExpired++;
        } catch (err) {
          report.failures++;
          this.recordFailure("database", db.id, err);
        }
      }

      // 2. Expire sessions whose leases ended; destroy their databases.
      for (const session of this.deps.sessions.list()) {
        if (!session.isActive) continue;
        if (session.expiresAt.getTime() <= now) {
          try {
            const result = await this.deps.sessions.expire(session.id);
            report.sessionsExpired++;
            report.databasesDestroyedForSessions += result.databasesDestroyed;
          } catch (err) {
            report.failures++;
            this.recordFailure("session", session.id, err);
          }
        }
      }

      // 3. Reap failed/closed templates (retain READY immutable templates).
      for (const template of this.deps.templates.list()) {
        if (template.state === "READY") continue;
        if (template.state === "FAILED" || template.state === "CLOSED" || template.state === "CLOSING") {
          try {
            await this.deps.templates.destroy(template.id);
            report.templatesReaped++;
          } catch (err) {
            report.failures++;
            this.recordFailure("template", template.id, err);
          }
        }
      }
    } finally {
      this.running = false;
    }

    if (report.failures > 0) {
      this.deps.metrics.increment("litegres_reaper_failures_total", report.failures);
    }
    this.deps.metrics.setGauge("litegres_active_databases", this.deps.databases.size);
    this.deps.metrics.setGauge("litegres_active_sessions", this.deps.sessions.size);
    this.deps.metrics.setGauge("litegres_active_templates", this.deps.templates.size);
    return report;
  }

  private recordFailure(kind: string, id: string, err: unknown): void {
    this.deps.logger.error("reaper cleanup failed", {
      kind,
      id,
      errorCode: (err as { code?: string }).code ?? "DATABASE_CLEANUP_FAILED",
      error: (err as Error).message,
    });
  }
}
