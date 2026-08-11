/**
 * Generic lifecycle state machine.
 *
 * All long-lived resources (daemon, databases, templates, sessions) use an
 * explicit state machine with a fixed set of allowed transitions. There is
 * no representation of lifecycle as loosely related booleans, and invalid
 * transitions are rejected.
 */
import { ApiError } from "../api/errors";

export type StateKind = "daemon" | "database" | "template" | "session";

export function createStateMachine<K extends string>(
  kind: StateKind,
  states: readonly K[],
  transitions: Record<K, readonly K[]>,
) {
  function assertValidState(state: K): void {
    if (!states.includes(state)) {
      throw new Error(`Unknown ${kind} state: ${String(state)}`);
    }
  }

  /**
   * Transition `current` to `next` using the allowed transition table.
   * Returns `next` on success, throws ApiError INVALID_STATE_TRANSITION
   * otherwise. The same-state transition is allowed for idempotency.
   */
  function transition(current: K, next: K): K {
    assertValidState(current);
    assertValidState(next);
    if (current === next) return next;
    const allowed = transitions[current] ?? [];
    if (!allowed.includes(next)) {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        `Cannot transition ${kind} from ${String(current)} to ${String(next)}.`,
        409,
        { from: current, to: next },
      );
    }
    return next;
  }

  /** True when the transition would be permitted. */
  function canTransition(current: K, next: K): boolean {
    if (current === next) return true;
    const allowed = transitions[current] ?? [];
    return allowed.includes(next);
  }

  return { transition, canTransition, assertValidState };
}

export const DAEMON_STATES = [
  "STARTING",
  "READY",
  "DRAINING",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type DaemonState = (typeof DAEMON_STATES)[number];

export const DATABASE_STATES = [
  "CREATING",
  "INITIALIZING",
  "READY",
  "CLOSING",
  "CLOSED",
  "FAILED",
  "EXPIRED",
] as const;
export type DatabaseState = (typeof DATABASE_STATES)[number];

export const TEMPLATE_STATES = [
  "CREATING",
  "PROVISIONING",
  "INITIALIZING",
  "READY",
  "CLOSING",
  "CLOSED",
  "FAILED",
] as const;
export type TemplateState = (typeof TEMPLATE_STATES)[number];

export const SESSION_STATES = [
  "ACTIVE",
  "CLOSING",
  "CLOSED",
  "EXPIRED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const daemonMachine = createStateMachine<DaemonState>("daemon", DAEMON_STATES, {
  STARTING: ["READY", "STOPPING", "FAILED"],
  READY: ["DRAINING", "STOPPING", "FAILED"],
  DRAINING: ["STOPPING", "FAILED"],
  STOPPING: ["STOPPED", "FAILED"],
  STOPPED: [],
  FAILED: ["STOPPED"],
});

export const databaseMachine = createStateMachine<DatabaseState>(
  "database",
  DATABASE_STATES,
  {
    CREATING: ["INITIALIZING", "CLOSING", "FAILED"],
    INITIALIZING: ["READY", "CLOSING", "FAILED"],
    READY: ["CLOSING", "EXPIRED", "FAILED"],
    CLOSING: ["CLOSED", "FAILED"],
    CLOSED: [],
    FAILED: ["CLOSED"],
    EXPIRED: ["CLOSING"],
  },
);

export const templateMachine = createStateMachine<TemplateState>(
  "template",
  TEMPLATE_STATES,
  {
    CREATING: ["PROVISIONING", "INITIALIZING", "CLOSING", "FAILED"],
    PROVISIONING: ["INITIALIZING", "CLOSING", "FAILED"],
    INITIALIZING: ["READY", "CLOSING", "FAILED"],
    READY: ["CLOSING", "FAILED"],
    CLOSING: ["CLOSED", "FAILED"],
    CLOSED: [],
    FAILED: ["CLOSED"],
  },
);

export const sessionMachine = createStateMachine<SessionState>(
  "session",
  SESSION_STATES,
  {
    ACTIVE: ["CLOSING", "EXPIRED"],
    CLOSING: ["CLOSED", "EXPIRED"],
    CLOSED: [],
    EXPIRED: ["CLOSING"],
  },
);
