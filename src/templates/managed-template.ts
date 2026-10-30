/**
 * ManagedTemplate: an immutable, prepared template.
 *
 * While provisioning, the template owns an engine handle exposing a live
 * PostgreSQL endpoint so external migration tools (Flyway, Liquibase,
 * Prisma, ...) can populate it. Once finalized the endpoint is sealed and
 * only the engine's opaque, immutable template data remains; clones are
 * produced from that data.
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import { templateMachine, type TemplateState } from "../lifecycle/state-machine";
import type { EngineConnection, ProvisioningHandle, TemplateData } from "../engine/engine";
import type { TemplateId } from "../types";

export interface ManagedTemplateInit {
  id: TemplateId;
  fingerprint: string;
  name?: string;
  metadata: Record<string, string>;
  createdAt: Date;
  clock: Clock;
  closeTimeoutMs: number;
}

export class ManagedTemplate {
  readonly id: TemplateId;
  readonly fingerprint: string;
  readonly name?: string;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly closeTimeoutMs: number;
  /** Provisioning connection credentials (only valid while PROVISIONING). */
  provisioning: EngineConnection | null = null;

  private _state: TemplateState = "CREATING";
  private _lastUsedAt: Date | undefined;
  private _data: TemplateData | undefined;
  private _handle: ProvisioningHandle | null = null;
  private clock: Clock;
  private closePromise: Promise<void> | null = null;

  constructor(init: ManagedTemplateInit) {
    this.id = init.id;
    this.fingerprint = init.fingerprint;
    this.name = init.name;
    this.metadata = init.metadata;
    this.createdAt = init.createdAt;
    this.closeTimeoutMs = init.closeTimeoutMs;
    this.clock = init.clock;
  }

  get state(): TemplateState {
    return this._state;
  }

  get lastUsedAt(): Date | undefined {
    return this._lastUsedAt;
  }

  /** The engine's immutable template payload (set once READY). */
  get data(): TemplateData | undefined {
    return this._data;
  }

  get isReady(): boolean {
    return this._state === "READY";
  }

  setState(next: TemplateState): void {
    this._state = templateMachine.transition(this._state, next);
  }

  /** Attach the engine handle used while provisioning. */
  attachProvisioning(handle: ProvisioningHandle): void {
    this._handle = handle;
    this.provisioning = handle.connection;
  }

  /** Seal the provisioned template and return its data (does not change state). */
  async sealProvisioning(): Promise<TemplateData> {
    if (!this._handle) {
      throw new ApiError("TEMPLATE_NOT_READY", `Template ${this.id} is not being provisioned.`, 409, {
        templateId: this.id,
      });
    }
    const data = await this._handle.finalize();
    this._handle = null;
    return data;
  }

  /** Store the immutable template data and mark the template READY. */
  markReady(data: TemplateData): void {
    this._data = data;
    this.setState("READY");
  }

  /** Record that a clone was produced from this template. */
  markUsed(): void {
    this._lastUsedAt = this.clock.now();
  }

  requireReady(): void {
    if (!this.isReady) {
      throw new ApiError(
        "TEMPLATE_NOT_READY",
        `Template ${this.id} is not ready (state: ${this._state}).`,
        409,
        { templateId: this.id, state: this._state },
      );
    }
  }

  /** Idempotent resource cleanup. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    const handle = this._handle;
    this._handle = null;
    if (!handle) return;
    try {
      await withTimeout(handle.abort(), this.closeTimeoutMs, "provisioning abort timeout");
    } catch {
      // best-effort
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
