import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("administrative exec endpoint", () => {
  test("executes SQL and returns rows", async () => {
    t = await startTestDaemon();
    const db = await api<{ id: string; connection: { database: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ fields: string[]; rows: Record<string, unknown>[] }>(t, "POST", `/v1/databases/${db.body.id}/exec`, {
      sql: "SELECT current_database() AS db, 1 + 1 AS two",
    });
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual(["db", "two"]);
    expect(res.body.rows[0]).toEqual({ db: db.body.connection.database, two: 2 });
  });

  test("supports parameters", async () => {
    t = await startTestDaemon();
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ rows: Record<string, unknown>[] }>(t, "POST", `/v1/databases/${db.body.id}/exec`, {
      sql: "SELECT $1::int AS n",
      parameters: [7],
    });
    expect(res.body.rows[0]).toEqual({ n: 7 });
  });

  test("SQL errors are structured", async () => {
    t = await startTestDaemon();
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ error: { code: string } }>(t, "POST", `/v1/databases/${db.body.id}/exec`, { sql: "SELECT * FROM missing_table" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EXEC_FAILED");
  });

  test("missing sql is rejected", async () => {
    t = await startTestDaemon();
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api(t, "POST", `/v1/databases/${db.body.id}/exec`, {});
    expect(res.status).toBe(400);
  });

  test("row limits are enforced", async () => {
    t = await startTestDaemon({ config: { maxExecRows: 2 } });
    const db = await api<{ id: string }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ error: { code: string } }>(t, "POST", `/v1/databases/${db.body.id}/exec`, {
      sql: "SELECT generate_series(1, 10)",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EXEC_ROW_LIMIT");
  });
});
