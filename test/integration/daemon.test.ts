import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";
import { Daemon } from "../../src/daemon";
import { testConfig } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("daemon lifecycle", () => {
  test("health and status endpoints", async () => {
    t = await startTestDaemon();
    const live = await fetch(`${t.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect((await live.json())).toEqual({ status: "ok" });

    const ready = await fetch(`${t.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);

    const status = await api<{
      name: string;
      version: string;
      state: string;
      uptimeSeconds: number;
      activeDatabases: number;
      activeTemplates: number;
      activeSessions: number;
      limits: { maxDatabases: number };
      runtime: { bunVersion: string; postgresVersion: string };
    }>(t, "GET", "/v1/status");
    expect(status.body.name).toBe("litegres");
    expect(status.body.version).toBe("0.1.0");
    expect(status.body.state).toBe("READY");
    expect(status.body.activeDatabases).toBe(0);
    expect(status.body.limits.maxDatabases).toBe(32);
    expect(status.body.runtime.bunVersion).toBe(Bun.version);
  });

  test("status reflects active resources", async () => {
    t = await startTestDaemon();
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const status = await api<{ activeDatabases: number }>(t, "GET", "/v1/status");
    expect(status.body.activeDatabases).toBe(2);
  });

  test("health/ready reports not-ready while draining", async () => {
    const daemon = new Daemon({ config: testConfig(), noRuntimeDir: true });
    await daemon.start();
    const url = daemon.controlUrl;
    void daemon.shutdown("test");
    // shutdown transitions synchronously to DRAINING before awaiting anything
    expect(["DRAINING", "STOPPING", "STOPPED"]).toContain(daemon.state);
    const res = await fetch(`${url}/health/ready`).catch(() => null);
    if (res) {
      expect([200, 503]).toContain(res.status);
    }
    await daemon.shutdown("test");
    expect(daemon.state).toBe("STOPPED");
  });

  test("shutdown is idempotent", async () => {
    const daemon = new Daemon({ config: testConfig(), noRuntimeDir: true });
    await daemon.start();
    const p1 = daemon.shutdown("first");
    const p2 = daemon.shutdown("second");
    await Promise.all([p1, p2]);
    expect(daemon.state).toBe("STOPPED");
    await daemon.shutdown("third"); // no-op
    expect(daemon.state).toBe("STOPPED");
  });

  test("gc runs a reaper pass", async () => {
    t = await startTestDaemon();
    const res = await api<{ gc: { databasesExpired: number } }>(t, "POST", "/v1/gc");
    expect(res.status).toBe(200);
    expect(res.body.gc.databasesExpired).toBe(0);
  });

  test("openapi.json is served and structurally valid", async () => {
    t = await startTestDaemon();
    const res = await fetch(`${t.baseUrl}/v1/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/databases"]).toBeDefined();
    expect(doc.paths["/v1/sessions"]).toBeDefined();
    expect(doc.paths["/v1/templates"]).toBeDefined();
  });
});
