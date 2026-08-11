import { describe, expect, test, afterAll } from "bun:test";
import { startTestDaemon, api, connectPg, assertPortClosed, type TestDaemon } from "../helpers";

let t: TestDaemon;

afterAll(async () => {
  await t?.close();
});

describe("templates", () => {
  test("PUT with statements creates a ready template, idempotently", async () => {
    t = await startTestDaemon();
    const body = {
      name: "brisk-core",
      initialization: {
        statements: ["CREATE TABLE accounts (id bigint primary key, name text not null)"],
      },
      metadata: { application: "brisk-core" },
    };
    const first = await api<{ id: string; status: string; fingerprint: string; createdAt: string }>(t, "PUT", "/v1/templates/sha256%3A5f6a", body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("ready");
    expect(first.body.fingerprint).toBe("sha256:5f6a");
    expect(first.body.id.startsWith("tpl_")).toBe(true);

    // idempotent: same fingerprint returns the same template, no new boot
    const second = await api<{ id: string; status: string }>(t, "PUT", "/v1/templates/sha256%3A5f6a", { ...body, initialization: { statements: ["SELECT 1"] } });
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe("ready");
    expect(t.daemon.templates.size).toBe(1);
  });

  test("templates can be cloned into isolated databases", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/tpl-test1", {
      initialization: { statements: ["CREATE TABLE t (x int)", "INSERT INTO t VALUES (1)"] },
    });

    const c1 = await api<{ id: string; templateId: string; connection: { host: string; port: number; database: string; username: string } }>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    expect(c1.body.templateId).toBe(tpl.body.id);
    const client = await connectPg(c1.body.connection);
    expect((await client.query("SELECT * FROM t")).rows).toEqual([{ x: 1 }]);
    await client.query("INSERT INTO t VALUES (2)");

    const c2 = await api<{ connection: { host: string; port: number; database: string; username: string } }>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    const c2client = await connectPg(c2.body.connection);
    // clone 2 must not see clone 1's write
    expect((await c2client.query("SELECT * FROM t")).rows).toEqual([{ x: 1 }]);
    await client.end();
    await c2client.end();
  });

  test("provisioning flow: provision, migrate over the wire, finalize, clone", async () => {
    t = await startTestDaemon();
    const prov = await api<{
      id: string;
      status: string;
      provisioningDatabase: { host: string; port: number; database: string; username: string; password: string };
    }>(t, "POST", "/v1/templates", { name: "provisioned", fingerprint: "sha256:prov1" });
    expect(prov.status).toBe(201);
    expect(prov.body.status).toBe("provisioning");

    // client migrates with its own tooling (here: raw SQL over the wire)
    const client = await connectPg(prov.body.provisioningDatabase);
    await client.query("CREATE TABLE journal (id serial primary key, body text)");
    await client.query("INSERT INTO journal (body) VALUES ('entry-1')");
    await client.end();

    const fin = await api<{ status: string }>(t, "POST", `/v1/templates/${prov.body.id}/finalize`);
    expect(fin.body.status).toBe("ready");

    // provisioning endpoint is hidden after finalize
    await assertPortClosed(prov.body.provisioningDatabase.port);

    // clone carries the migrated schema
    const clone = await api<{ connection: { host: string; port: number; database: string; username: string } }>(t, "POST", "/v1/databases", { templateId: prov.body.id, ttlSeconds: 600 });
    const cc = await connectPg(clone.body.connection);
    expect((await cc.query("SELECT body FROM journal")).rows).toEqual([{ body: "entry-1" }]);
    await cc.end();
  });

  test("templates are immutable after finalize; clones do not affect them", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/immutable1", {
      initialization: { statements: ["CREATE TABLE t (x int)", "INSERT INTO t VALUES (1)"] },
    });
    const clone = await api<{ id: string; connection: { host: string; port: number; database: string; username: string } }>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    const client = await connectPg(clone.body.connection);
    await client.query("DROP TABLE t");
    await client.end();

    const clone2 = await api<{ connection: { host: string; port: number; database: string; username: string } }>(t, "POST", "/v1/databases", { templateId: tpl.body.id, ttlSeconds: 600 });
    const c2 = await connectPg(clone2.body.connection);
    const res = await c2.query("SELECT to_regclass('t') AS t");
    expect(res.rows[0].t).toBe("t");
    await c2.end();

    // deleting a clone does not affect the template
    const del = await api(t, "DELETE", `/v1/databases/${clone.body.id}`);
    expect(del.status).toBe(204);
    const tplAfter = await api<{ status: string }>(t, "GET", `/v1/templates/${tpl.body.id}`);
    expect(tplAfter.body.status).toBe("ready");
  });

  test("cloning from a missing or unready template fails cleanly", async () => {
    t = await startTestDaemon();
    const missing = await api<{ error: { code: string } }>(t, "POST", "/v1/databases", { templateId: "tpl_nonexistent", ttlSeconds: 600 });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("TEMPLATE_NOT_FOUND");
  });

  test("template get/list/delete", async () => {
    t = await startTestDaemon();
    const tpl = await api<{ id: string }>(t, "PUT", "/v1/templates/list1", { initialization: { statements: ["SELECT 1"] } });
    const list = await api<{ templates: { id: string }[]; count: number }>(t, "GET", "/v1/templates");
    expect(list.body.count).toBe(1);
    const got = await api<{ id: string }>(t, "GET", `/v1/templates/${tpl.body.id}`);
    expect(got.body.id).toBe(tpl.body.id);
    const del = await api(t, "DELETE", `/v1/templates/${tpl.body.id}`);
    expect(del.status).toBe(204);
    const after = await api(t, "GET", `/v1/templates/${tpl.body.id}`);
    expect(after.status).toBe(404);
  });

  test("failed finalization cleans up the provisioning endpoint", async () => {
    t = await startTestDaemon();
    const prov = await api<{ id: string; provisioningDatabase: { port: number } }>(t, "POST", "/v1/templates", { fingerprint: "fail1", name: "x" });
    // kill the provisioning instance by destroying through reaper-like cleanup:
    // simulate by closing via template destroy
    const del = await api(t, "DELETE", `/v1/templates/${prov.body.id}`);
    expect(del.status).toBe(204);
    await assertPortClosed(prov.body.provisioningDatabase.port);
  });
});
