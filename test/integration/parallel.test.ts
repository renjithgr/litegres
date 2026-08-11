import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("parallel database creation", () => {
  test("concurrent creation yields unique, independent databases", async () => {
    t = await startTestDaemon({ config: { maxDatabases: 32 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api<{ id: string; connection: { port: number; host: string; database: string; username: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const ids = results.map((r) => r.body.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate IDs
    const ports = results.map((r) => r.body.connection.port);
    expect(new Set(ports).size).toBe(ports.length); // no duplicate ports

    // every database works over the wire
    for (const r of results) {
      const client = await connectPg(r.body.connection);
      const res = await client.query("SELECT 1 AS one");
      expect(res.rows[0]).toEqual({ one: 1 });
      await client.end();
    }
    expect(t.daemon.databases.size).toBe(6);
    expect(t.daemon.databases.pendingCount()).toBe(0);
  });

  test("concurrent creation respects capacity with no registry corruption", async () => {
    t = await startTestDaemon({ config: { maxDatabases: 3 } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api<{ error?: { code: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 429);
    expect(created.length).toBe(3);
    expect(rejected.length).toBe(5);
    expect(t.daemon.databases.size).toBe(3);
  });

  test("concurrent deletion races are safe", async () => {
    t = await startTestDaemon();
    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 }),
      ),
    );
    const ids = created.map((c) => c.body.id);
    const results = await Promise.all(ids.map((id) => api(t, "DELETE", `/v1/databases/${id}`)));
    for (const r of results) expect(r.status).toBe(204);
    // duplicate deletes are safe too
    const again = await Promise.all(ids.map((id) => api(t, "DELETE", `/v1/databases/${id}`)));
    for (const r of again) expect(r.status).toBe(204);
    expect(t.daemon.databases.size).toBe(0);
  });
});
