/**
 * Ownership: a daemon's startup sweep drops only the databases
 * of daemons that are gone, never those of a live daemon that happens to
 * share the name prefix.
 */
import { describe, expect, test, afterAll } from "bun:test";
import pg from "pg";
import { startTestDaemon, api, canConnect, testPostgresUrl, type PgConnection, type TestDaemon } from "../helpers";

const daemons: TestDaemon[] = [];
const OWNER_LOCK_NAMESPACE = 0x4c474553;

afterAll(async () => {
  for (const d of daemons) await d.close();
});

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testPostgresUrl(), ssl: false });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function exists(name: string): Promise<boolean> {
  return admin(async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1);
}

async function start(prefix: string): Promise<TestDaemon> {
  const d = await startTestDaemon({ config: { namePrefix: prefix } });
  daemons.push(d);
  return d;
}

describe("database ownership and orphan sweep", () => {
  test("a second daemon with the same prefix does not drop a live daemon's databases", async () => {
    const prefix = `litegres_test_own${Math.random().toString(36).slice(2, 7)}_`;
    const a = await start(prefix);
    const dbA = await api<{ id: string; connection: PgConnection }>(a, "POST", "/v1/databases", { ttlSeconds: 600 });
    const tpl = await api<{ id: string }>(a, "PUT", "/v1/templates/own-tpl", {
      initialization: { statements: ["CREATE TABLE t (x int)"] },
    });
    expect(await canConnect(dbA.body.connection)).toBe(true);

    // B starts against the same server and prefix and sweeps
    const b = await start(prefix);
    expect(await exists(dbA.body.connection.database)).toBe(true);
    expect(await canConnect(dbA.body.connection)).toBe(true);

    // A's template still clones, and B works independently
    const clone = await api<{ connection: PgConnection }>(a, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    expect(clone.status).toBe(201);
    const dbB = await api<{ connection: PgConnection }>(b, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(dbB.status).toBe(201);
    expect(dbB.body.connection.database).not.toBe(dbA.body.connection.database);
  });

  test("databases of a dead owner and untagged ones are dropped on startup", async () => {
    const prefix = `litegres_test_dead${Math.random().toString(36).slice(2, 7)}_`;
    const orphan = `${prefix}deadbeef_db_orphan`; // tag with no live lock holder
    const untagged = `${prefix}legacy`;
    const unrelated = `unrelated_${Math.random().toString(36).slice(2, 7)}`;
    await admin(async (c) => {
      await c.query(`CREATE DATABASE "${orphan}"`);
      await c.query(`CREATE DATABASE "${untagged}"`);
      await c.query(`CREATE DATABASE "${unrelated}"`);
    });
    try {
      await start(prefix);
      expect(await exists(orphan)).toBe(false);
      expect(await exists(untagged)).toBe(false);
      expect(await exists(unrelated)).toBe(true); // never matches the prefix
    } finally {
      await admin((c) => c.query(`DROP DATABASE IF EXISTS "${unrelated}" WITH (FORCE)`));
    }
  });

  test("a database whose owner lock is held survives; once released it is swept", async () => {
    const prefix = `litegres_test_lock${Math.random().toString(36).slice(2, 7)}_`;
    const key = 0x0badf00d;
    const guarded = `${prefix}0badf00d_db_guarded`;
    await admin((c) => c.query(`CREATE DATABASE "${guarded}"`));

    // stand-in for a live foreign daemon: hold its ownership lock
    const holder = new pg.Client({ connectionString: testPostgresUrl(), ssl: false });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1::int, $2::int)", [OWNER_LOCK_NAMESPACE, key]);
    try {
      await start(prefix);
      expect(await exists(guarded)).toBe(true);
    } finally {
      await holder.end(); // the "daemon" dies; its lock is released
    }

    await start(prefix);
    expect(await exists(guarded)).toBe(false);
  });
});
