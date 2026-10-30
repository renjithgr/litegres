import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, assertEndpointClosed, type PgConnection, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("sessions", () => {
  test("create, list, get, renew", async () => {
    t = await startTestDaemon();
    const created = await api<{ id: string; leaseToken: string; status: string; expiresAt: string; createdAt: string }>(
      t,
      "POST",
      "/v1/sessions",
      { client: { name: "tests", version: "1.0", pid: 123, framework: "bun:test" }, ttlSeconds: 1800, metadata: { gitCommit: "abc" } },
    );
    expect(created.status).toBe(201);
    expect(created.body.id.startsWith("ses_")).toBe(true);
    expect(created.body.leaseToken.startsWith("tok_")).toBe(true);
    expect(created.body.status).toBe("active");

    const got = await api<{ id: string }>(t, "GET", `/v1/sessions/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);
    // list never includes lease tokens
    const list = await api<{ sessions: Record<string, unknown>[] }>(t, "GET", "/v1/sessions");
    expect("leaseToken" in list.body.sessions[0]!).toBe(false);

    const renewed = await api<{ expiresAt: string }>(t, "POST", `/v1/sessions/${created.body.id}/renew`, { ttlSeconds: 3600 });
    expect(new Date(renewed.body.expiresAt).getTime()).toBeGreaterThan(new Date(created.body.expiresAt).getTime());
  });

  test("deleting a session destroys its databases", async () => {
    t = await startTestDaemon();
    const ses = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const db = await api<{ id: string; connection: PgConnection }>(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });
    const db2 = await api<{ id: string; connection: PgConnection }>(t, "POST", "/v1/databases", { sessionId: ses.body.id, ttlSeconds: 600 });

    const del = await api(t, "DELETE", `/v1/sessions/${ses.body.id}`);
    expect(del.status).toBe(204);
    // idempotent
    const del2 = await api(t, "DELETE", `/v1/sessions/${ses.body.id}`);
    expect(del2.status).toBe(204);

    await assertEndpointClosed(db.body.connection);
    await assertEndpointClosed(db2.body.connection);
    const list = await api<{ databases: unknown[] }>(t, "GET", "/v1/databases");
    expect(list.body.databases).toHaveLength(0);
  });

  test("deleting one session does not affect another", async () => {
    t = await startTestDaemon();
    const s1 = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const s2 = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const d1 = await api<{ connection: { port: number } }>(t, "POST", "/v1/databases", { sessionId: s1.body.id, ttlSeconds: 600 });
    const d2 = await api<{ id: string; connection: { port: number } }>(t, "POST", "/v1/databases", { sessionId: s2.body.id, ttlSeconds: 600 });
    await api(t, "DELETE", `/v1/sessions/${s1.body.id}`);
    const list = await api<{ databases: { id: string }[] }>(t, "GET", "/v1/databases");
    expect(list.body.databases).toHaveLength(1);
    expect(list.body.databases[0]!.id).toBe(d2.body.id ?? undefined);
    void d1;
  });

  test("session lease token authorizes scoped operations", async () => {
    t = await startTestDaemon();
    const ses = await api<{ id: string; leaseToken: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const leaseHeaders = { "content-type": "application/json", "x-litegres-lease-token": ses.body.leaseToken };

    // create a database in the session using only the lease token
    const res = await fetch(`${t.baseUrl}/v1/databases`, {
      method: "POST",
      headers: leaseHeaders,
      body: JSON.stringify({ sessionId: ses.body.id, ttlSeconds: 600 }),
    });
    expect(res.status).toBe(201);
    const db = (await res.json()) as { id: string };

    // renew the database with the lease token
    const renew = await fetch(`${t.baseUrl}/v1/databases/${db.id}/renew`, {
      method: "POST",
      headers: leaseHeaders,
      body: JSON.stringify({ ttlSeconds: 600 }),
    });
    expect(renew.status).toBe(200);

    // delete the session with the lease token
    const del = await fetch(`${t.baseUrl}/v1/sessions/${ses.body.id}`, {
      method: "DELETE",
      headers: leaseHeaders,
    });
    expect(del.status).toBe(204);
  });

  test("invalid lease tokens are rejected", async () => {
    t = await startTestDaemon();
    const bad = { "content-type": "application/json", "x-litegres-lease-token": "tok_wrong" };
    const res = await fetch(`${t.baseUrl}/v1/databases`, {
      method: "POST",
      headers: bad,
      body: JSON.stringify({ ttlSeconds: 600 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("a lease token cannot manage another session's database", async () => {
    t = await startTestDaemon();
    const s1 = await api<{ id: string; leaseToken: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const s2 = await api<{ id: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 1800 });
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { sessionId: s2.body.id, ttlSeconds: 600 });
    const res = await fetch(`${t.baseUrl}/v1/databases/${db.body.id}`, {
      method: "DELETE",
      headers: { "x-litegres-lease-token": s1.body.leaseToken },
    });
    expect(res.status).toBe(403);
  });
});
