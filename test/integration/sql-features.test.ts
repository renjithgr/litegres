import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, type TestDaemon } from "../helpers";

let t: TestDaemon;
let client: Awaited<ReturnType<typeof connectPg>>;

afterAll(async () => {
  await client?.end().catch(() => {});
  await t?.close();
});

describe("PostgreSQL wire-protocol features through the data plane", () => {
  test("transactions, rollback, savepoints", async () => {
    t = await startTestDaemon();
    const db = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    client = await connectPg(db.body.connection);

    await client.query("CREATE TABLE tx (id int primary key, v text)");
    await client.query("BEGIN");
    await client.query("INSERT INTO tx VALUES (1, 'committed')");
    await client.query("SAVEPOINT sp1");
    await client.query("INSERT INTO tx VALUES (2, 'rolled-back')");
    await client.query("ROLLBACK TO SAVEPOINT sp1");
    await client.query("INSERT INTO tx VALUES (3, 'after-sp')");
    await client.query("COMMIT");
    const rows = await client.query("SELECT id FROM tx ORDER BY id");
    expect(rows.rows).toEqual([{ id: 1 }, { id: 3 }]);

    // explicit rollback
    await client.query("BEGIN");
    await client.query("INSERT INTO tx VALUES (4, 'never')");
    await client.query("ROLLBACK");
    const after = await client.query("SELECT count(*)::int AS n FROM tx");
    expect(after.rows[0].n).toBe(2);
  });

  test("RETURNING, JSONB, arrays, enums", async () => {
    t = await startTestDaemon();
    const db = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    client = await connectPg(db.body.connection);

    await client.query("CREATE TYPE mood_type AS ENUM ('happy', 'sad')");
    await client.query("CREATE TABLE t (id serial primary key, data jsonb, tags text[], mood mood_type)");
    const ins = await client.query(
      "INSERT INTO t (data, tags, mood) VALUES ($1, $2, $3) RETURNING id",
      [JSON.stringify({ a: 1 }), ["x", "y"], "happy"],
    );
    expect(ins.rows[0].id).toBe(1);
    const q = await client.query("SELECT data->>'a' AS a, tags[1] AS t1, mood FROM t WHERE id = 1");
    expect(q.rows[0]).toEqual({ a: "1", t1: "x", mood: "happy" });
  });

  test("foreign keys, unique constraints, ON CONFLICT", async () => {
    t = await startTestDaemon();
    const db = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    client = await connectPg(db.body.connection);

    await client.query("CREATE TABLE parent (id int primary key)");
    await client.query("CREATE TABLE child (id int primary key, parent_id int references parent(id))");
    await client.query("INSERT INTO parent VALUES (1)");
    await client.query("INSERT INTO child VALUES (1, 1)");
    // FK violation
    await expect(client.query("INSERT INTO child VALUES (2, 99)")).rejects.toThrow(/foreign key/i);
    // unique violation
    await expect(client.query("INSERT INTO parent VALUES (1)")).rejects.toThrow(/duplicate key/i);
    // ON CONFLICT
    await client.query("INSERT INTO parent VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1");
    const count = await client.query("SELECT count(*)::int AS n FROM parent");
    expect(count.rows[0].n).toBe(1);
  });

  test("multiple statements and prepared-style parameters via wire", async () => {
    t = await startTestDaemon();
    const db = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    client = await connectPg(db.body.connection);
    await client.query("CREATE TABLE items (id int primary key, label text)");
    for (let i = 0; i < 5; i++) {
      await client.query("INSERT INTO items VALUES ($1, $2)", [i, `item-${i}`]);
    }
    const res = await client.query("SELECT label FROM items WHERE id = $1", [3]);
    expect(res.rows).toEqual([{ label: "item-3" }]);
  });

  test("connection survives multiple queries (no single-shot limitation)", async () => {
    t = await startTestDaemon();
    const db = await api<{ connection: { host: string; port: number; database: string; username: string; password: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    client = await connectPg(db.body.connection);
    for (let i = 0; i < 20; i++) {
      const res = await client.query("SELECT $1::int AS n", [i]);
      expect(res.rows[0].n).toBe(i);
    }
  });
});
