/**
 * Database reset: restore a database to its initial state under the same
 * name and credentials.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, canConnect, type PgConnection, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

type Created = { id: string; connection: PgConnection };

async function count(conn: PgConnection, table: string): Promise<number> {
  const c = await connectPg(conn);
  try {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0].n as number;
  } finally {
    await c.end().catch(() => {});
  }
}

describe("database reset", () => {
  test("restores the template state with the same name and credentials", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/reset-tpl", {
      initialization: { statements: ["CREATE TABLE t (x int)", "INSERT INTO t VALUES (1), (2)"] },
    });
    const created = await api<Created>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    const conn = created.body.connection;

    // dirty it: change data and schema, keep a connection open across the reset
    const open = await connectPg(conn);
    await open.query("INSERT INTO t VALUES (3), (4), (5)");
    await open.query("CREATE TABLE extra (y int)");
    expect(await count(conn, "t")).toBe(5);

    const before = await api<{ host: string; port: number; database: string; expiresAt: string }>(t, "GET", `/v1/databases/${created.body.id}`);
    const reset = await api<{ id: string; status: string; database: string }>(t, "POST", `/v1/databases/${created.body.id}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.id).toBe(created.body.id);
    expect(reset.body.status).toBe("ready");
    expect(reset.body.database).toBe(conn.database);

    // same coordinates and credentials, original contents, schema changes gone
    expect(await count(conn, "t")).toBe(2);
    const c = await connectPg(conn);
    const extra = await c.query("SELECT to_regclass('extra') AS r");
    expect(extra.rows[0].r).toBeNull();
    await c.end();

    // the connection that was open across the reset was terminated
    await expect(open.query("SELECT 1")).rejects.toBeDefined();
    await open.end().catch(() => {});

    // lease and descriptor are untouched
    const after = await api<{ host: string; port: number; database: string; expiresAt: string }>(t, "GET", `/v1/databases/${created.body.id}`);
    expect(after.body.host).toBe(before.body.host);
    expect(after.body.port).toBe(before.body.port);
    expect(after.body.database).toBe(before.body.database);
    expect(after.body.expiresAt).toBe(before.body.expiresAt);
  });

  test("an empty database is re-initialized from its statements", async () => {
    t = await startTestDaemon();
    const created = await api<Created>(t, "POST", "/v1/databases", {
      ttlSeconds: 600,
      initialization: { statements: ["CREATE TABLE seed (n int)", "INSERT INTO seed VALUES (7)"] },
    });
    const conn = created.body.connection;
    const c = await connectPg(conn);
    await c.query("INSERT INTO seed VALUES (8), (9)");
    await c.query("DROP TABLE seed");
    await c.end();

    const reset = await api(t, "POST", `/v1/databases/${created.body.id}/reset`);
    expect(reset.status).toBe(200);
    expect(await count(conn, "seed")).toBe(1);
  });

  test("a database can be reset many times in a row", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/reset-many", {
      initialization: { statements: ["CREATE TABLE t (x int)"] },
    });
    const created = await api<Created>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    for (let i = 0; i < 5; i++) {
      const c = await connectPg(created.body.connection);
      await c.query("INSERT INTO t VALUES (1)");
      await c.end();
      expect((await api(t, "POST", `/v1/databases/${created.body.id}/reset`)).status).toBe(200);
      expect(await count(created.body.connection, "t")).toBe(0);
    }
  });

  test("reset of an unknown database is 404 and another session's lease token is refused", async () => {
    t = await startTestDaemon();
    const missing = await api<{ error: { code: string } }>(t, "POST", "/v1/databases/db_missing/reset");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("DATABASE_NOT_FOUND");

    const s1 = await api<{ id: string; leaseToken: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 600 });
    const s2 = await api<{ id: string; leaseToken: string }>(t, "POST", "/v1/sessions", { ttlSeconds: 600 });
    const db = await api<Created>(t, "POST", "/v1/databases", { sessionId: s1.body.id, ttlSeconds: 600 });

    const wrong = await fetch(`${t.baseUrl}/v1/databases/${db.body.id}/reset`, {
      method: "POST",
      headers: { "x-litegres-lease-token": s2.body.leaseToken },
    });
    expect(wrong.status).toBe(403);
    const right = await fetch(`${t.baseUrl}/v1/databases/${db.body.id}/reset`, {
      method: "POST",
      headers: { "x-litegres-lease-token": s1.body.leaseToken },
    });
    expect(right.status).toBe(200);
    expect(await canConnect(db.body.connection)).toBe(true);
  });
});
