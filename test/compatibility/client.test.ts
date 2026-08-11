import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, type TestDaemon } from "../helpers";
import { LitegresClient, LitegresError } from "../../clients/typescript/src/index";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("TypeScript client", () => {
  test("connect, session, database, wire flow", async () => {
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);

    const session = await client.createSession({
      client: { name: "client-test", framework: "bun:test" },
      ttlSeconds: 1800,
      metadata: { gitCommit: "abc123" },
    });
    expect(session.id.startsWith("ses_")).toBe(true);
    expect(session.leaseToken).toBeDefined();
    expect(session.metadata.gitCommit).toBe("abc123");

    const database = await client.createDatabase({
      sessionId: session.id,
      ttlSeconds: 600,
      initialization: { statements: ["CREATE TABLE accounts (id int primary key)"] },
    });
    expect(database.status).toBe("ready");
    expect(database.connection.postgresUrl).toContain("postgresql://");
    expect(database.connection.jdbcUrl).toContain("sslmode=disable");

    const got = await client.getDatabase(database.id);
    expect(got.id).toBe(database.id);

    const renewed = await client.renewDatabase(database.id, 1200);
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(new Date(database.expiresAt).getTime());

    await client.deleteDatabase(database.id);
    await expect(client.getDatabase(database.id)).rejects.toThrow(LitegresError);

    await client.deleteSession(session.id);
    await expect(client.getSession(session.id)).rejects.toThrow(LitegresError);
  });

  test("discovery-based connect finds a running daemon", async () => {
    // The daemon in this test uses noRuntimeDir, so discovery is disabled;
    // verify connectTo against the control URL instead (discovery is covered
    // by the process-level tests).
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);
    const status = await client.status();
    expect(status.state).toBe("READY");
  });

  test("typed errors carry code and status", async () => {
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);
    await expect(client.createDatabase({ sessionId: "ses_missing", ttlSeconds: 60 })).rejects.toMatchObject({
      name: "LitegresError",
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
  });

  test("lease-token-scoped client can manage its own resources", async () => {
    t = await startTestDaemon();
    const admin = LitegresClient.connectTo(t.baseUrl, t.token);
    const session = await admin.createSession({ ttlSeconds: 1800 });
    const scoped = LitegresClient.connectTo(t.baseUrl);
    scoped.setLeaseToken(session.leaseToken);

    const db = await scoped.createDatabase({ sessionId: session.id, ttlSeconds: 600 });
    expect(db.status).toBe("ready");
    await scoped.deleteDatabase(db.id);
    await scoped.deleteSession(session.id);
  });

  test("template helpers: put, provision, finalize, clone", async () => {
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);

    const tpl = await client.putTemplate({
      fingerprint: "sha256:client-test",
      name: "client-template",
      initialization: { statements: ["CREATE TABLE t (x int)", "INSERT INTO t VALUES (1)"] },
    });
    expect(tpl.status).toBe("ready");

    // idempotent
    const tpl2 = await client.putTemplate({ fingerprint: "sha256:client-test", initialization: { statements: ["SELECT 1"] } });
    expect(tpl2.id).toBe(tpl.id);

    const prov = await client.createTemplate({ fingerprint: "sha256:client-prov", name: "p" });
    expect(prov.status).toBe("provisioning");
    expect(prov.provisioningDatabase?.port).toBeGreaterThan(0);
    const finalized = await client.finalizeTemplate(prov.id);
    expect(finalized.status).toBe("ready");

    const db = await client.createDatabase({ templateId: tpl.id, ttlSeconds: 600 });
    expect(db.status).toBe("ready");
    expect(db.templateId).toBe(tpl.id);
    await client.deleteDatabase(db.id);
    await client.deleteTemplate(prov.id);
  });

  test("list and filter endpoints", async () => {
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);
    const session = await client.createSession({ ttlSeconds: 1800 });
    await client.createDatabase({ sessionId: session.id, ttlSeconds: 600, metadata: { application: "brisk-core" } });
    const list = await client.listDatabases({ application: "brisk-core" });
    expect(list.count).toBe(1);
    expect(list.databases[0]!.metadata.application).toBe("brisk-core");
    const all = await client.listDatabases();
    expect(all.count).toBe(1);
    const sessions = await client.listSessions();
    expect(sessions.count).toBe(1);
    const templates = await client.listTemplates();
    expect(templates.count).toBe(0);
  });

  test("exec helper", async () => {
    t = await startTestDaemon();
    const client = LitegresClient.connectTo(t.baseUrl, t.token);
    const db = await client.createDatabase({ ttlSeconds: 600 });
    const result = await client.exec(db.id, "SELECT 40 + 2 AS answer");
    expect(result.rows[0]).toEqual({ answer: 42 });
    await client.deleteDatabase(db.id);
  });
});
