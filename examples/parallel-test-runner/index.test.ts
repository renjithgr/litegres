/**
 * Parallel test runner example.
 *
 * One Litegres daemon, many isolated databases, one per test. Each test
 * gets its own disposable PostgreSQL endpoint through the control plane and
 * runs its queries over the wire protocol. Deleting the session at the end
 * destroys everything the run created.
 *
 * Prerequisite: a running daemon (`litegresd run` in another terminal).
 */
import { beforeEach, afterEach, afterAll, expect, test } from "bun:test";
import { LitegresClient } from "@litegres/client";
import pg from "pg";

const client = await LitegresClient.connect();
let session: Awaited<ReturnType<typeof client.createSession>>;

beforeEach(async () => {
  session = await client.createSession({ client: { name: "parallel-runner" }, ttlSeconds: 600 });
});

afterEach(async () => {
  await client.deleteSession(session.id).catch(() => {});
});

afterAll(async () => {
  // safety net: expire any session this example leaked
  await client.gc().catch(() => {});
});

async function withDb(fn: (db: Awaited<ReturnType<typeof client.createDatabase>>) => Promise<void>): Promise<void> {
  const db = await client.createDatabase({ sessionId: session.id, ttlSeconds: 300 });
  const pgc = new pg.Client({
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.username,
    password: db.connection.password,
  });
  await pgc.connect();
  try {
    await fn(db);
  } finally {
    await pgc.end();
  }
}

test("test 1: creates its own table", async () => {
  await withDb(async (db) => {
    const pgc = new pg.Client({ host: db.connection.host, port: db.connection.port, user: "postgres", database: "postgres" });
    await pgc.connect();
    await pgc.query("CREATE TABLE alpha (id int)");
    await pgc.query("INSERT INTO alpha VALUES (1)");
    expect((await pgc.query("SELECT count(*)::int AS n FROM alpha")).rows[0].n).toBe(1);
    await pgc.end();
  });
});

test("test 2: runs in parallel with test 1 and sees a fresh database", async () => {
  await withDb(async (db) => {
    const pgc = new pg.Client({ host: db.connection.host, port: db.connection.port, user: "postgres", database: "postgres" });
    await pgc.connect();
    // the alpha table from test 1 must not exist here
    const res = await pgc.query("SELECT to_regclass('alpha') AS t");
    expect(res.rows[0].t).toBeNull();
    await pgc.query("CREATE TABLE alpha (x text)");
    await pgc.end();
  });
});
