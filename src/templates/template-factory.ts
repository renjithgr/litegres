/**
 * TemplateFactory: boots template instances, applies initialization, and
 * produces immutable snapshots.
 */
import { ApiError } from "../api/errors";
import { DatabaseFactory } from "../databases/database-factory";
import type { DaemonConfig } from "../config/config";
import type { Metrics } from "../observability/metrics";
import { snapshotPglite } from "../packaging/pglite-assets";
import type { PGlite } from "@electric-sql/pglite";

export interface TemplateFactoryDeps {
  config: DaemonConfig;
  metrics: Metrics;
  databaseFactory: DatabaseFactory;
}

export class TemplateFactory {
  constructor(private deps: TemplateFactoryDeps) {}

  /**
   * Create a template instance with statements applied. Returns the
   * instance plus its snapshot (instance already closed after snapshot).
   */
  async createFromStatements(
    statements: string[],
    context: { templateId: string },
  ): Promise<Blob> {
    const { metrics, databaseFactory } = this.deps;
    const booted = await databaseFactory.boot();
    try {
      await databaseFactory.applyInitialization(booted.pglite, { statements });
      return await metrics.timed("litegres_template_snapshot_duration_ms", () =>
        snapshotPglite(booted.pglite),
      );
    } catch (err) {
      throw new ApiError(
        "TEMPLATE_CREATION_FAILED",
        `Template ${context.templateId} creation failed: ${(err as Error).message}`,
        500,
      );
    } finally {
      await booted.pglite.close().catch(() => {});
      await booted.socketServer.stop().catch(() => {});
    }
  }

  /** Snapshot a provisioned instance. The instance stays open for the caller. */
  async snapshotProvisioned(pglite: PGlite): Promise<Blob> {
    return this.deps.metrics.timed("litegres_template_snapshot_duration_ms", () =>
      snapshotPglite(pglite),
    );
  }
}
