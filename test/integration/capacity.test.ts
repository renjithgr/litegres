import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("capacity management", () => {
  test("maxDatabases is enforced with 429 and a structured error", async () => {
    t = await startTestDaemon({ config: { maxDatabases: 2 } });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ error: { code: string; details: { active: number; maximum: number } } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("DATABASE_CAPACITY_EXHAUSTED");
    expect(res.body.error.details).toEqual({ active: 2, maximum: 2 });
  });

  test("maxDatabasesPerSession is enforced", async () => {
    t = await startTestDaemon({ config: { maxDatabases: 32, maxDatabasesPerSession: 2 } });
    const ses = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    await api(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });
    await api(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });
    const res = await api<{ error: { code: string } }>(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("DATABASE_CAPACITY_EXHAUSTED");
  });

  test("destroying databases frees capacity", async () => {
    t = await startTestDaemon({ config: { maxDatabases: 1 } });
    const first = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    await api(t, "DELETE", `/v1/databases/${first.body.id}`);
    const second = await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(second.status).toBe(201);
  });

  test("maxTemplates is enforced", async () => {
    t = await startTestDaemon({ config: { maxTemplates: 1 } });
    await api(t, "PUT", "/v1/templates/fp1", { initialization: { statements: ["SELECT 1"] } });
    const res = await api<{ error: { code: string } }>(t, "PUT", "/v1/templates/fp2", { initialization: { statements: ["SELECT 1"] } });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("TEMPLATE_CAPACITY_EXHAUSTED");
  });
});
