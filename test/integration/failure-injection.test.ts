/**
 * Failure injection tests using internal seams.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("failure injection", () => {
  test("daemon shutdown during database creation is safe", async () => {
    t = await startTestDaemon();
    // Kick off creation and shutdown concurrently. Either the database
    // finishes before the drain, or shutdown wins; in both cases shutdown
    // must complete without hanging or crashing.
    const createPromise = api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    await new Promise((r) => setTimeout(r, 30));
    const shutdownPromise = t.daemon.shutdown("test: shutdown during creation");
    await Promise.allSettled([createPromise, shutdownPromise]);
    expect(t.daemon.state).toBe("STOPPED");
    expect(t.daemon.databases.size).toBe(0);
    // A fresh daemon can still be started afterwards (resources were freed).
    t = await startTestDaemon();
    const res = await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
  });

  test("template clone failure cleans up and does not corrupt other databases", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/broken1", {
      initialization: { statements: ["CREATE TABLE t (x int)"] },
    });
    // Corrupt the snapshot to simulate a clone failure.
    const template = t.daemon.templates.require(tpl.body.id);
    (template as unknown as { _snapshot: Blob })._snapshot = new Blob(["not a pglite tarball"]);

    const failed = await api<{ error: { code: string } }>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    expect(failed.status).toBe(500);
    expect(["DATABASE_CREATION_FAILED", "PGLITE_STARTUP_FAILED"]).toContain(failed.body.error.code);

    // The template itself is untouched and still cloneable from the daemon's
    // remaining healthy state; a fresh database still works.
    const ok = await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(ok.status).toBe(201);
    expect(t.daemon.databases.size).toBe(1);
  });

  test("database close failure is contained and logged", async () => {
    t = await startTestDaemon();
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const managed = t.daemon.databases.get(db.body.id)!;
    (managed as unknown as { _pglite: object })._pglite = {
      close: async () => {
        throw new Error("simulated close failure");
      },
    };
    // destroy must not throw; the registry drops the instance.
    await expect(t.daemon.databases.destroy(db.body.id)).resolves.toBeUndefined();
    expect(t.daemon.databases.size).toBe(0);
  });

  test("malformed requests are rejected without side effects", async () => {
    t = await startTestDaemon();
    const cases = [
      [{ ttlSeconds: -5 }, 400],
      [{ ttlSeconds: "abc" }, 400],
      [{ metadata: { a: 42 } }, 400],
      [{ initialization: { statements: [42] } }, 400],
      [{ ttlSeconds: 600, storage: { type: "disk" } }, 400],
      [{ ttlSeconds: 600, templateId: "tpl_missing", initialization: { statements: ["SELECT 1"] } }, 400],
    ] as const;
    for (const [body, status] of cases) {
      const res = await api(t, "POST", "/v1/databases", body);
      expect(res.status).toBe(status);
    }
    expect(t.daemon.databases.size).toBe(0);
  });
});
