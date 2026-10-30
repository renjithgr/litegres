import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, TEST_ENGINE, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

/** Databases are distinct endpoints: own port (pglite) or own database name (native). */
const endpoint = (c: { port: number; database: string }) => `${c.port}/${c.database}`;

describe("database isolation", () => {
  test("concurrent databases are fully isolated", async () => {
    t = await startTestDaemon();
    const a = await api<{ id: string; connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const b = await api<{ id: string; connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });

    expect(endpoint(a.body.connection)).not.toBe(endpoint(b.body.connection));
    expect(a.body.id).not.toBe(b.body.id);

    const ca = await connectPg(a.body.connection);
    const cb = await connectPg(b.body.connection);
    await ca.query("CREATE TABLE t (x int)");
    await ca.query("INSERT INTO t VALUES (42)");

    // table in A does not exist in B
    const inB = await cb.query("SELECT to_regclass('t') AS t");
    expect(inB.rows[0].t).toBeNull();

    // rows in A do not appear in B
    await cb.query("CREATE TABLE t (x int)");
    const rowsB = await cb.query("SELECT * FROM t");
    expect(rowsB.rows).toHaveLength(0);

    await ca.end();
    await cb.end();

    // deleting A does not affect B
    await api(t, "DELETE", `/v1/databases/${a.body.id}`);
    const clientB = await connectPg(b.body.connection);
    await clientB.query("INSERT INTO t VALUES (7)");
    const rows = await clientB.query("SELECT count(*)::int AS n FROM t");
    expect(rows.rows[0].n).toBe(1);
    await clientB.end();
  });

  test("endpoints are distinct; credentials follow the engine", async () => {
    t = await startTestDaemon();
    const a = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const b = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    if (TEST_ENGINE === "pglite") {
      expect(a.body.connection.password).not.toBe(b.body.connection.password);
    } else {
      // The native engine hands out the PostgreSQL server's own credentials.
      expect(a.body.connection.password).toBe(b.body.connection.password);
    }
    expect(endpoint(a.body.connection)).not.toBe(endpoint(b.body.connection));
  });
});
