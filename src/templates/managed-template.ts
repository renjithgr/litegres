/**
 * ManagedTemplate: an immutable, prepared PGlite snapshot.
 *
 * While provisioning, the template owns a live PGlite instance and an
 * ephemeral PostgreSQL endpoint so external migration tools (Flyway,
 * Liquibase, Prisma, ...) can provision it. Once finalized, the endpoint is
 * closed, the instance is closed, and only the immutable snapshot tarball
 * remains; clones are produced from that tarball.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import { templateMachine, type TemplateState } from "../lifecycle/state-machine";
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
  provisioning: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  } | null = null;

  private _state: TemplateState = "CREATING";
  private _lastUsedAt: Date | undefined;
  private _snapshot: Blob | undefined;
  private _pglite: PGlite | null = null;
  private _socketServer: PGLiteSocketServer | null = null;
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

  get snapshot(): Blob | undefined {
    return this._snapshot;
  }

  get isReady(): boolean {
    return this._state === "READY";
  }

  get pglite(): PGlite | null {
    return this._pglite;
  }

  get socketServer(): PGLiteSocketServer | null {
    return this._socketServer;
  }

  setState(next: TemplateState): void {
    this._state = templateMachine.transition(this._state, next);
  }

  /** Attach the live instance and endpoint used while provisioning. */
  attachProvisioningInstance(pglite: PGlite, socketServer: PGLiteSocketServer, port: number): void {
    this._pglite = pglite;
    this._socketServer = socketServer;
    if (this.provisioning) {
      this.provisioning.port = port;
    }
  }

  setProvisioningConnection(conn: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  }): void {
    this.provisioning = conn;
  }

  /** Store the immutable snapshot and mark the template READY. */
  async finalizeSnapshot(snapshot: Blob): Promise<void> {
    this._snapshot = snapshot;
    // Close the provisioning endpoint and instance.
    await this.close();
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
    if (this._socketServer) {
      try {
        await withTimeout(this._socketServer.stop(), this.closeTimeoutMs, "socket stop timeout");
      } catch {
        // best-effort
      } finally {
        this._socketServer = null;
      }
    }
    if (this._pglite) {
      try {
        await withTimeout(this._pglite.close(), this.closeTimeoutMs, "pglite close timeout");
      } catch {
        // best-effort
      } finally {
        this._pglite = null;
      }
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
