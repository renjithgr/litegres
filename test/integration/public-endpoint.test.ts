/**
 * Advertised endpoint: publicHost / publicPort rewrite what the control API
 * returns, while the daemon keeps using the real server address internally.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, type PgConnection, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

type Created = {
  id: string;
  host: string;
  port: number;
  connection: PgConnection & { postgresUrl: string; jdbcUrl: string };
};

describe("advertised endpoint", () => {
  test("by default the connection points at the PostgreSQL server itself", async () => {
    t = await startTestDaemon();
    const res = await api<Created>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
    const url = new URL(process.env.LITEGRES_TEST_POSTGRES_URL!);
    expect(res.body.connection.host).toBe(url.hostname);
    expect(res.body.connection.port).toBe(Number(url.port));
    expect(res.body.connection.jdbcUrl).toContain(`/${res.body.connection.database}?sslmode=disable`);
  });

  test("publicHost and publicPort are advertised everywhere a connection is returned", async () => {
    t = await startTestDaemon({ config: { publicHost: "db.example.test", publicPort: 6543 } });
    const res = await api<Created>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
    const c = res.body.connection;
    expect(c.host).toBe("db.example.test");
    expect(c.port).toBe(6543);
    expect(c.postgresUrl).toContain("@db.example.test:6543/");
    expect(c.jdbcUrl).toContain("//db.example.test:6543/");
    expect(res.body.host).toBe("db.example.test");
    expect(res.body.port).toBe(6543);

    const got = await api<{ host: string; port: number }>(t, "GET", `/v1/databases/${res.body.id}`);
    expect(got.body.host).toBe("db.example.test");
    expect(got.body.port).toBe(6543);

    // the real server is still reachable by the daemon: the database is ready
    // and exec works, even though the advertised address is fictional
    const exec = await api<{ rows: unknown[] }>(t, "POST", `/v1/databases/${res.body.id}/exec`, { sql: "SELECT 1 AS one" });
    expect(exec.status).toBe(200);
    expect(exec.body.rows).toEqual([{ one: 1 }]);
  });

  test("a real client connects with the unrewritten address", async () => {
    t = await startTestDaemon();
    const res = await api<Created>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const client = await connectPg(res.body.connection);
    expect((await client.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
    await client.end();
  });
});
