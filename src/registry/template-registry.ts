/**
 * TemplateRegistry: owns prepared, immutable template snapshots.
 *
 * Two creation paths:
 *  - PUT /v1/templates/{fingerprint} with initialization statements
 *    (idempotent, returns an existing healthy template for the fingerprint)
 *  - POST /v1/templates for external provisioning, later finalized
 *    (migrations run by the client's own tooling against an ephemeral
 *    PostgreSQL endpoint, then POST /v1/templates/{id}/finalize)
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import type { DaemonConfig } from "../config/config";
import { DatabaseFactory } from "../databases/database-factory";
import { assertWireReadiness } from "../databases/readiness";
import { generateId } from "../ids";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";
import { generateCredentials } from "../security/credentials";
import { ManagedTemplate } from "../templates/managed-template";
import { TemplateFactory } from "../templates/template-factory";
import { assertValidFingerprint } from "../templates/fingerprint";
import type { TemplateDescriptor, TemplateId } from "../types";
import type { DatabaseRegistry, TemplateSnapshot } from "./database-registry";

export interface CreateTemplateOptions {
  name?: string;
  fingerprint: string;
  metadata?: Record<string, string>;
  initialization?: { statements?: string[] };
}

export interface TemplateRegistryDeps {
  config: DaemonConfig;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  databaseFactory: DatabaseFactory;
  templateFactory: TemplateFactory;
  databases: DatabaseRegistry;
}

export class TemplateRegistry {
  private templates = new Map<TemplateId, ManagedTemplate>();
  private deps: TemplateRegistryDeps;

  constructor(deps: TemplateRegistryDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.templates.size;
  }

  get(id: TemplateId): ManagedTemplate | undefined {
    return this.templates.get(id);
  }

  require(id: TemplateId): ManagedTemplate {
    const template = this.templates.get(id);
    if (!template) {
      throw new ApiError("TEMPLATE_NOT_FOUND", `Template ${id} was not found.`, 404, {
        templateId: id,
      });
    }
    return template;
  }

  list(): ManagedTemplate[] {
    return [...this.templates.values()];
  }

  findByFingerprint(fingerprint: string): ManagedTemplate | undefined {
    for (const template of this.templates.values()) {
      if (template.fingerprint === fingerprint) return template;
    }
    return undefined;
  }

  private checkCapacity(): void {
    const { config, metrics } = this.deps;
    if (this.templates.size >= config.maxTemplates) {
      metrics.increment("litegres_template_capacity_rejections_total");
      throw new ApiError(
        "TEMPLATE_CAPACITY_EXHAUSTED",
        "Litegres has reached its configured template limit.",
        429,
        { active: this.templates.size, maximum: config.maxTemplates },
      );
    }
  }

  /**
   * PUT /v1/templates/{fingerprint}: idempotent create-with-statements.
   * Returns an existing healthy template for the same fingerprint.
   */
  async getOrCreateByFingerprint(
    options: CreateTemplateOptions,
  ): Promise<ManagedTemplate> {
    assertValidFingerprint(options.fingerprint);
    const existing = this.findByFingerprint(options.fingerprint);
    if (existing) {
      if (existing.isReady) {
        existing.markUsed();
        return existing;
      }
      throw new ApiError(
        "TEMPLATE_NOT_READY",
        `A template with fingerprint ${options.fingerprint} already exists but is not ready (state: ${existing.state}).`,
        409,
        { fingerprint: options.fingerprint, templateId: existing.id, state: existing.state },
      );
    }
    this.checkCapacity();

    const template = new ManagedTemplate({
      id: generateId("tpl"),
      fingerprint: options.fingerprint,
      name: options.name,
      metadata: options.metadata ?? {},
      createdAt: this.deps.clock.now(),
      clock: this.deps.clock,
      closeTimeoutMs: this.deps.config.databaseCloseTimeoutMs,
    });
    this.templates.set(template.id, template);
    this.deps.metrics.setGauge("litegres_active_templates", this.templates.size);

    try {
      template.setState("INITIALIZING");
      const snapshot = await this.deps.templateFactory.createFromStatements(
        options.initialization?.statements ?? [],
        { templateId: template.id },
      );
      await template.finalizeSnapshot(snapshot);
      template.markUsed();
      this.deps.metrics.increment("litegres_templates_created_total");
      this.deps.logger.info("template created from statements", {
        templateId: template.id,
        fingerprint: options.fingerprint,
        statements: options.initialization?.statements?.length ?? 0,
      });
      return template;
    } catch (err) {
      this.templates.delete(template.id);
      this.deps.metrics.setGauge("litegres_active_templates", this.templates.size);
      this.deps.metrics.increment("litegres_templates_failed_total");
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        "TEMPLATE_CREATION_FAILED",
        `Template ${template.id} could not be created: ${(err as Error).message}`,
        500,
      );
    }
  }

  /**
   * POST /v1/templates: create a template in PROVISIONING state with a live
   * PostgreSQL endpoint so an external migration tool can populate it.
   */
  async createProvisioning(options: CreateTemplateOptions): Promise<ManagedTemplate> {
    assertValidFingerprint(options.fingerprint);
    this.checkCapacity();

    const template = new ManagedTemplate({
      id: generateId("tpl"),
      fingerprint: options.fingerprint,
      name: options.name,
      metadata: options.metadata ?? {},
      createdAt: this.deps.clock.now(),
      clock: this.deps.clock,
      closeTimeoutMs: this.deps.config.databaseCloseTimeoutMs,
    });
    const credentials = generateCredentials();

    try {
      const booted = await this.deps.databaseFactory.boot();
      template.attachProvisioningInstance(booted.pglite, booted.socketServer, booted.port);
      template.setProvisioningConnection({
        host: this.deps.config.host,
        port: booted.port,
        database: "postgres",
        username: credentials.username,
        password: credentials.password,
      });
      template.setState("PROVISIONING");
      this.templates.set(template.id, template);
      this.deps.metrics.setGauge("litegres_active_templates", this.templates.size);

      // Prove the provisioning endpoint is usable by an external client.
      const conn = template.provisioning!;
      await assertWireReadiness(
        {
          host: conn.host,
          port: conn.port,
          database: conn.database,
          username: conn.username,
          password: conn.password,
        },
        this.deps.config.controlApiReadinessTimeoutMs,
        { databaseId: template.id, host: conn.host, port: conn.port },
      );
      this.deps.metrics.increment("litegres_templates_created_total");
      this.deps.logger.info("template provisioning started", {
        templateId: template.id,
        fingerprint: options.fingerprint,
        port: conn.port,
      });
      return template;
    } catch (err) {
      await template.close().catch(() => {});
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        "TEMPLATE_CREATION_FAILED",
        `Template ${template.id} could not be provisioned: ${(err as Error).message}`,
        500,
      );
    }
  }

  /**
   * POST /v1/templates/{id}/finalize: verify the provisioning endpoint,
   * snapshot the instance, close the endpoint, mark the template READY and
   * immutable.
   */
  async finalize(id: TemplateId): Promise<ManagedTemplate> {
    const template = this.require(id);
    if (template.isReady) return template; // idempotent
    if (template.state !== "PROVISIONING") {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `Template ${id} cannot be finalized from state ${template.state}.`,
        409,
        { templateId: id, state: template.state },
      );
    }
    template.setState("INITIALIZING");
    try {
      const conn = template.provisioning!;
      // Final verification through the wire protocol.
      await assertWireReadiness(
        {
          host: conn.host,
          port: conn.port,
          database: conn.database,
          username: conn.username,
          password: conn.password,
        },
        this.deps.config.controlApiReadinessTimeoutMs,
        { databaseId: id, host: conn.host, port: conn.port },
      );
      const snapshot = await this.deps.templateFactory.snapshotProvisioned(template.pglite!);
      await template.finalizeSnapshot(snapshot);
      template.markUsed();
      this.deps.logger.info("template finalized", { templateId: id, fingerprint: template.fingerprint });
      return template;
    } catch (err) {
      template.setState("FAILED");
      this.deps.logger.error("template finalization failed", {
        templateId: id,
        error: (err as Error).message,
      });
      throw new ApiError(
        "TEMPLATE_CREATION_FAILED",
        `Template ${id} finalization failed: ${(err as Error).message}`,
        500,
      );
    }
  }

  /** Get the immutable snapshot for cloning; requires READY. */
  getSnapshot(id: TemplateId): TemplateSnapshot {
    const template = this.require(id);
    template.requireReady();
    if (!template.snapshot) {
      throw new ApiError("TEMPLATE_NOT_READY", `Template ${id} has no snapshot.`, 409, {
        templateId: id,
      });
    }
    template.markUsed();
    return { tarball: template.snapshot, capturedAt: template.createdAt };
  }

  /** Idempotent template destruction. */
  async destroy(id: TemplateId): Promise<void> {
    const template = this.templates.get(id);
    if (!template) return;
    template.setState("CLOSING");
    await template.close();
    template.setState("CLOSED");
    this.templates.delete(id);
    this.deps.metrics.setGauge("litegres_active_templates", this.templates.size);
    this.deps.logger.info("template destroyed", { templateId: id });
  }

  async destroyAll(): Promise<number> {
    const ids = [...this.templates.keys()];
    for (const id of ids) {
      await this.destroy(id);
    }
    return ids.length;
  }

  toDescriptor(template: ManagedTemplate): TemplateDescriptor {
    return {
      id: template.id,
      fingerprint: template.fingerprint,
      name: template.name,
      status: template.state,
      createdAt: template.createdAt.toISOString(),
      lastUsedAt: template.lastUsedAt?.toISOString(),
      metadata: template.metadata,
    };
  }
}
