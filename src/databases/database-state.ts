/**
 * Database lifecycle state. The canonical state definitions live in the
 * lifecycle state machine; this module re-exports them and adds small
 * database-specific helpers.
 */
import {
  DATABASE_STATES,
  type DatabaseState,
  databaseMachine,
} from "../lifecycle/state-machine";

export type { DatabaseState };

export function isTerminalDatabaseState(state: DatabaseState): boolean {
  return state === "CLOSED" || state === "FAILED" || state === "EXPIRED";
}

export function canClose(state: DatabaseState): boolean {
  return databaseMachine.canTransition(state, "CLOSING");
}

export { DATABASE_STATES, databaseMachine };
