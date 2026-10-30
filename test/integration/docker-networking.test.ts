/**
 * Docker-oriented networking: fixed data-plane port ranges and advertised
 * (public) host/port rewriting.
 *
 * These features let the daemon run behind Docker port publishing:
 * databases bind predictable in-container ports (fixed range), and the
 * control API advertises the host-visible address (publicHost /
 * publicPortBase) in every connection string.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, TEST_ENGINE, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

// Fixed per-database port ranges only exist on the pglite engine; the native
// engine serves every database from the PostgreSQL server's own port.
describe.skipIf(TEST_ENGINE !== "pglite")("docker networking", () => {
  test("fixed data-plane range keeps every database port inside the range", async () => {
    t = await startTestDaemon({ config: { dataPlanePortBase: 41200, dataPlanePortCount: 4 } });
    const ports: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await api<{ id: string; connection: { port: number; host: string } }>(t, "POST", "/v1/databases", {
        ttlSeconds: 600,
      });
      expect(res.status).toBe(201);
      expect(res.body.connection.port).toBeGreaterThanOrEqual(41200);
      expect(res.body.connection.port).toBeLessThan(41204);
      ports.push(res.body.connection.port);
    }
    expect(new Set(ports).size).toBe(3); // distinct ports

    // every endpoint actually serves PostgreSQL on the bind host
    for (const port of ports) {
      const client = await connectPg({ host: "127.0.0.1", port, database: "postgres", username: "postgres", password: undefined });
      const r = await client.query("SELECT 1 AS one");
      expect(r.rows[0]).toEqual({ one: 1 });
      await client.end();
    }
  });

  test("exhausting the fixed range fails with a clear error", async () => {
    t = await startTestDaemon({ config: { dataPlanePortBase: 41300, dataPlanePortCount: 2 } });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    await api(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    const res = await api<{ error: { code: string; message: string } }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("DATA_PLANE_PORTS_EXHAUSTED");
    expect(res.body.error.message).toContain("data-plane ports");
  });

  test("publicHost/publicPortBase are advertised while the daemon binds locally", async () => {
    t = await startTestDaemon({
      config: {
        dataPlanePortBase: 41400,
        dataPlanePortCount: 4,
        publicHost: "localhost",
        publicPortBase: 52000,
      },
    });
    const res = await api<{
      id: string;
      connection: { host: string; port: number; postgresUrl: string; jdbcUrl: string };
    }>(t, "POST", "/v1/databases", { ttlSeconds: 600 });
    expect(res.status).toBe(201);
    const { host, port, postgresUrl, jdbcUrl } = res.body.connection;
    expect(host).toBe("localhost");
    expect(port).toBeGreaterThanOrEqual(52000);
    expect(port).toBeLessThan(52004);
    expect(postgresUrl).toContain("localhost:" + port);
    expect(jdbcUrl).toContain("localhost:" + port);

    // the daemon really bound 41400+offset on the loopback interface
    const bindPort = port - 52000 + 41400;
    const client = await connectPg({ host: "127.0.0.1", port: bindPort, database: "postgres", username: "postgres", password: undefined });
    const r = await client.query("SELECT current_database() AS db");
    expect(r.rows[0]).toEqual({ db: "postgres" });
    await client.end();

    // get/list also advertise the public address
    const listed = await api<{ databases: Array<{ host: string; port: number }> }>(t, "GET", "/v1/databases");
    expect(listed.body.databases[0]?.host).toBe("localhost");
  });
});
