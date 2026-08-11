import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("authentication", () => {
  test("mutations without a token are rejected", async () => {
    t = await startTestDaemon();
    for (const [method, path, body] of [
      ["POST", "/v1/sessions", { ttlSeconds: 600 }],
      ["POST", "/v1/databases", { ttlSeconds: 600 }],
      ["PUT", "/v1/templates/abc", { initialization: { statements: ["SELECT 1"] } }],
      ["POST", "/v1/shutdown", undefined],
    ] as const) {
      const res = await fetch(`${t.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status).toBe(401);
    }
  });

  test("invalid bearer token is rejected", async () => {
    t = await startTestDaemon();
    const res = await fetch(`${t.baseUrl}/v1/databases`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ ttlSeconds: 600 }),
    });
    expect(res.status).toBe(401);
  });

  test("health endpoints are unauthenticated", async () => {
    t = await startTestDaemon();
    const live = await fetch(`${t.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${t.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
  });

  test("daemon token works for all mutations", async () => {
    t = await startTestDaemon();
    const res = await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
  });

  test("template mutations require the daemon token (not just any session)", async () => {
    t = await startTestDaemon();
    const ses = await api<{ leaseToken: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const res = await fetch(`${t.baseUrl}/v1/templates`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-litegres-lease-token": ses.body.leaseToken },
      body: JSON.stringify({ fingerprint: "sha256:x", name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("status exposes no secrets", async () => {
    t = await startTestDaemon();
    const res = await api<Record<string, unknown>>(t, "GET", "/v1/status");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(t.token);
    expect(text).not.toContain("password");
  });
});
