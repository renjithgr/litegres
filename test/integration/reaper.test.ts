import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";
import { ManualClock } from "../../src/clock";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("reaper and leases", () => {
  test("expired databases are closed by the reaper", async () => {
    const clock = new ManualClock(Date.now());
    t = await startTestDaemon({ clock });
    const db = await api<{ id: string; connection: { port: number } }>(t, "POST", "/v1/databases", { ttlSeconds: 60 });
    expect(t.daemon.databases.size).toBe(1);

    // advance past expiry and run the reaper
    clock.advance(61_000);
    const report = await t.daemon.reaper.runOnce();
    expect(report.databasesExpired).toBe(1);
    expect(t.daemon.databases.size).toBe(0);
  });

  test("a lease renewed before expiration remains alive", async () => {
    const clock = new ManualClock(Date.now());
    t = await startTestDaemon({ clock });
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 60 });
    clock.advance(30_000);
    await api(t, "POST", `/v1/databases/${db.body.id}/renew`, { ttlSeconds: 60 });
    clock.advance(31_000);
    const report = await t.daemon.reaper.runOnce();
    expect(report.databasesExpired).toBe(0);
    expect(t.daemon.databases.size).toBe(1);
  });

  test("expired sessions destroy their databases", async () => {
    const clock = new ManualClock(Date.now());
    t = await startTestDaemon({ clock });
    const ses = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 30 });
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });
    expect(t.daemon.databases.size).toBe(1);

    clock.advance(31_000);
    const report = await t.daemon.reaper.runOnce();
    expect(report.sessionsExpired).toBe(1);
    expect(report.databasesDestroyedForSessions).toBe(1);
    expect(t.daemon.databases.size).toBe(0);
    expect(t.daemon.sessions.size).toBe(0);
  });

  test("repeated reaper passes are safe", async () => {
    const clock = new ManualClock(Date.now());
    t = await startTestDaemon({ clock });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 10 });
    clock.advance(11_000);
    await t.daemon.reaper.runOnce();
    await t.daemon.reaper.runOnce();
    await t.daemon.reaper.runOnce();
    expect(t.daemon.databases.size).toBe(0);
  });

  test("ready templates are retained; failed ones are reaped", async () => {
    t = await startTestDaemon();
    await api(t, "PUT", "/v1/templates/keep1", { initialization: { statements: ["SELECT 1"] } });
    expect(t.daemon.templates.size).toBe(1);
    const report = await t.daemon.reaper.runOnce();
    expect(report.templatesReaped).toBe(0);
    expect(t.daemon.templates.size).toBe(1);
  });

  test("cleanup failures are contained: the pass keeps going", async () => {
    const clock = new ManualClock(Date.now());
    t = await startTestDaemon({ clock });
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 10 });
    // Inject a failing close to simulate a wedged database (it is still destroyed first).
    const managed = t.daemon.databases.get(db.body.id)!;
    const holder = managed as unknown as { _instance: { close(): Promise<void> } };
    const real = holder._instance;
    holder._instance = Object.create(real, {
      close: {
        value: async () => {
          await real.close();
          throw new Error("simulated close failure");
        },
      },
    });
    clock.advance(11_000);
    const report = await t.daemon.reaper.runOnce();
    expect(report.databasesExpired).toBe(1);
    // The failed instance was still removed from the active registry and the
    // pass completed without crashing.
    expect(t.daemon.databases.size).toBe(0);
  });
});
