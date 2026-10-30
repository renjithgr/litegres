import { describe, expect, test, afterAll } from "bun:test";
import type { PgConnection } from "../helpers";
import { startTestDaemon, api, connectPg, canConnect, assertEndpointClosed, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("database lifecycle", () => {
  test("creates a database and serves real PostgreSQL", async () => {
    t = await startTestDaemon();
    const res = await api<{
      id: string;
      status: string;
      connection: { host: string; port: number; database: string; username: string; password: string; postgresUrl: string; jdbcUrl: string };
      createdAt: string;
      expiresAt: string;
    }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ready");
    expect(res.body.id.startsWith("db_")).toBe(true);
    expect(res.body.connection.port).toBeGreaterThan(0);
    expect(res.body.connection.postgresUrl).toContain("postgresql://");
    expect(res.body.connection.jdbcUrl).toContain("sslmode=disable");

    const client = await connectPg(res.body.connection);
    const one = await client.query("SELECT 1 AS one");
    expect(one.rows[0]).toEqual({ one: 1 });
    await client.query("CREATE TABLE t (id int primary key, name text)");
    await client.query("INSERT INTO t VALUES (1, 'a')");
    const rows = await client.query("SELECT * FROM t");
    expect(rows.rows).toEqual([{ id: 1, name: "a" }]);
    await client.end();
  });

  test("database deletion closes the PostgreSQL endpoint", async () => {
    t = await startTestDaemon();
    const res = await api<{ id: string; connection: PgConnection }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const conn = res.body.connection;
    expect(await canConnect(conn)).toBe(true);
    const del = await api(t, "DELETE", `/v1/databases/${res.body.id}`);
    expect(del.status).toBe(204);
    await assertEndpointClosed(conn);
    // idempotent second delete
    const del2 = await api(t, "DELETE", `/v1/databases/${res.body.id}`);
    expect(del2.status).toBe(204);
  });

  test("initialization statements run before readiness", async () => {
    t = await startTestDaemon();
    const res = await api<{ connection: { port: number; host: string; database: string; username: string }; id: string }>(t, "POST", "/v1/databases", {
      ttlSeconds: 600,
      initialization: { statements: ["CREATE TABLE accounts (id bigint primary key, name text not null)"] },
    });
    expect(res.status).toBe(201);
    const client = await connectPg(res.body.connection);
    const r = await client.query("SELECT to_regclass('accounts') AS t");
    expect(r.rows[0].t).toBe("accounts");
    await client.end();
  });

  test("failed initialization cleans up and returns DATABASE_CREATION_FAILED", async () => {
    t = await startTestDaemon();
    const res = await api<{ error: { code: string } }>(t, "POST", "/v1/databases", {
      ttlSeconds: 600,
      initialization: { statements: ["THIS IS NOT SQL"] },
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("DATABASE_CREATION_FAILED");
  });

  test("list responses never include passwords", async () => {
    t = await startTestDaemon();
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ databases: Record<string, unknown>[] }>(t, "GET", "/v1/databases");
    expect(res.status).toBe(200);
    expect(res.body.databases.length).toBe(1);
    expect("password" in res.body.databases[0]!).toBe(false);
    expect("connection" in res.body.databases[0]!).toBe(false);
    expect("postgresUrl" in res.body.databases[0]!).toBe(false);
  });

  test("database renewal updates expiresAt", async () => {
    t = await startTestDaemon();
    const created = await api<{ id: string; expiresAt: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const renewed = await api<{ expiresAt: string }>(t, "POST", `/v1/databases/${created.body.id}/renew`, { ttlSeconds: 1200 });
    expect(new Date(renewed.body.expiresAt).getTime()).toBeGreaterThan(new Date(created.body.expiresAt).getTime());
  });

  test("get returns descriptor without credentials", async () => {
    t = await startTestDaemon();
    const created = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const got = await api<{ id: string; status: string; host: string; port: number }>(t, "GET", `/v1/databases/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("ready");
    expect(got.body.port).toBeGreaterThan(0);
    const missing = await api(t, "GET", "/v1/databases/db_nonexistent");
    expect(missing.status).toBe(404);
  });

  test("storage types other than memory are rejected", async () => {
    t = await startTestDaemon();
    const res = await api(t, "POST", "/v1/databases", { ttlSeconds: 600, storage: { type: "disk" } });
    expect(res.status).toBe(400);
  });
});
