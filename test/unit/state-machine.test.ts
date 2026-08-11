import { describe, expect, test } from "bun:test";
import { daemonMachine, databaseMachine, sessionMachine, templateMachine } from "../../src/lifecycle/state-machine";
import { ApiError } from "../../src/api/errors";

describe("state machines", () => {
  test("database lifecycle follows the allowed path", () => {
    let s = "CREATING";
    s = databaseMachine.transition(s as never, "INITIALIZING" as never);
    s = databaseMachine.transition(s as never, "READY" as never);
    s = databaseMachine.transition(s as never, "CLOSING" as never);
    s = databaseMachine.transition(s as never, "CLOSED" as never);
    expect(s).toBe("CLOSED");
  });

  test("invalid transitions are rejected", () => {
    expect(() => databaseMachine.transition("CREATING" as never, "READY" as never)).toThrow(ApiError);
    expect(() => databaseMachine.transition("READY" as never, "CREATING" as never)).toThrow(ApiError);
    expect(() => databaseMachine.transition("CLOSED" as never, "READY" as never)).toThrow(ApiError);
    expect(() => sessionMachine.transition("CLOSED" as never, "ACTIVE" as never)).toThrow(ApiError);
    expect(() => templateMachine.transition("READY" as never, "PROVISIONING" as never)).toThrow(ApiError);
  });

  test("same-state transitions are allowed (idempotency)", () => {
    expect(databaseMachine.transition("READY" as never, "READY" as never)).toBe("READY");
    expect(daemonMachine.transition("READY" as never, "READY" as never)).toBe("READY");
  });

  test("daemon can drain and stop", () => {
    let s = "STARTING";
    s = daemonMachine.transition(s as never, "READY" as never);
    s = daemonMachine.transition(s as never, "DRAINING" as never);
    s = daemonMachine.transition(s as never, "STOPPING" as never);
    s = daemonMachine.transition(s as never, "STOPPED" as never);
    expect(s).toBe("STOPPED");
  });

  test("expired databases can only close", () => {
    expect(databaseMachine.canTransition("EXPIRED" as never, "CLOSING" as never)).toBe(true);
    expect(databaseMachine.canTransition("EXPIRED" as never, "READY" as never)).toBe(false);
  });
});
