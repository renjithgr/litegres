/**
 * ManagedSession: one client process or test run.
 */
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";
import { sessionMachine, type SessionState } from "../lifecycle/state-machine";
import type { SessionId } from "../types";

export interface SessionClientInfo {
  name?: string;
  version?: string;
  pid?: number;
  framework?: string;
}

export interface ManagedSessionInit {
  id: SessionId;
  leaseToken: string;
  client?: SessionClientInfo;
  metadata: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
  clock: Clock;
}

export class ManagedSession {
  readonly id: SessionId;
  readonly leaseToken: string;
  readonly client?: SessionClientInfo;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  private _expiresAt: Date;
  private _state: SessionState = "ACTIVE";
  private clock: Clock;

  constructor(init: ManagedSessionInit) {
    this.id = init.id;
    this.leaseToken = init.leaseToken;
    this.client = init.client;
    this.metadata = init.metadata;
    this.createdAt = init.createdAt;
    this._expiresAt = init.expiresAt;
    this.clock = init.clock;
  }

  get state(): SessionState {
    return this._state;
  }

  get expiresAt(): Date {
    return this._expiresAt;
  }

  get isActive(): boolean {
    return this._state === "ACTIVE";
  }

  setState(next: SessionState): void {
    this._state = sessionMachine.transition(this._state, next);
  }

  renewLease(durationMs: number): void {
    if (!this.isActive) {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `Cannot renew session ${this.id}: current state is ${this._state}.`,
        409,
        { state: this._state },
      );
    }
    this._expiresAt = new Date(this.clock.nowMs() + durationMs);
  }

  close(): void {
    if (this._state === "ACTIVE") this.setState("CLOSING");
    if (this._state === "CLOSING") this.setState("CLOSED");
  }
}
