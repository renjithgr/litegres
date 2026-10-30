/**
 * Process-level tests: run the compiled litegresd binary from a clean
 * temporary directory and exercise the whole lifecycle as an external
 * client would.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LitegresClient } from "../../clients/typescript/src/index";
import pg from "pg";
import { ensureTestPostgres } from "../helpers";

const repoRoot = resolve(import.meta.dir, "..", "..");
const BIN = process.env.LITEGRES_BIN ?? join(repoRoot, "dist", "litegresd");
// The daemon under test talks to the disposable PostgreSQL server that
// test/preload.ts provides.
async function pgEnv(): Promise<Record<string, string>> {
  return {
    LITEGRES_POSTGRES_URL: await ensureTestPostgres(),
    LITEGRES_POSTGRES_DOCKER: "false",
    LITEGRES_NAME_PREFIX: `litegres_proc_${Math.random().toString(36).slice(2, 8)}_`,
  };
}

interface RunningDaemon {
  proc: Bun.Subprocess;
  workDir: string;
  runtimeDir: string;
  controlPort: number;
  discoveryPath: string;
}

let running: RunningDaemon | null = null;

async function ensureBinary(): Promise<void> {
  if (existsSync(BIN)) return;
  const build = Bun.spawnSync(["bun", "run", join(repoRoot, "scripts", "build.ts")], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`Failed to build litegresd: ${build.stderr.toString()}`);
  }
}

async function startDaemon(): Promise<RunningDaemon> {
  const workDir = mkdtempSync(join(tmpdir(), "litegres-proc-"));
  const runtimeDir = join(workDir, "rt");
  const bin = join(workDir, "litegresd");
  cpSync(BIN, bin);
  const controlPort = 49200 + Math.floor(Math.random() * 500);
  const proc = Bun.spawn([bin, "run", "--log-level", "error"], {
    cwd: workDir,
    env: {
      ...process.env,
      ...(await pgEnv()),
      LITEGRES_RUNTIME_DIR: runtimeDir,
      LITEGRES_PORT: String(controlPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const info: RunningDaemon = {
    proc,
    workDir,
    runtimeDir,
    controlPort,
    discoveryPath: join(runtimeDir, "daemon.json"),
  };

  // Wait for the discovery file and a ready health check (bounded).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(info.discoveryPath)) {
      const discovery = JSON.parse(readFileSync(info.discoveryPath, "utf8")) as { pid: number; controlUrl: string };
      if (discovery.pid === proc.pid) {
        const res = await fetch(`${discovery.controlUrl}/health/ready`).catch(() => null);
        if (res?.ok) return info;
      }
    }
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(`litegresd exited early (${proc.exitCode}): ${stderr}`);
    }
    await Bun.sleep(150);
  }
  proc.kill();
  throw new Error("Daemon did not become ready in time");
}

async function stopDaemon(daemon: RunningDaemon, signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
  const exit = await new Promise<number>((resolveExit) => {
    const timer = setTimeout(() => {
      daemon.proc.kill("SIGKILL");
      resolveExit(daemon.proc.exitCode ?? -1);
    }, 15_000);
    daemon.proc.exited.then((code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    daemon.proc.kill(signal);
  });
  return exit;
}

beforeAll(async () => {
  await ensureBinary();
});

afterAll(async () => {
  if (running) {
    await stopDaemon(running).catch(() => {});
    rmSync(running.workDir, { recursive: true, force: true });
  }
});

describe("compiled litegresd from a clean directory", () => {
  test("full lifecycle: discovery, health, session, database, wire, delete, SIGTERM", async () => {
    running = await startDaemon();
    const { runtimeDir, discoveryPath, controlPort } = running;

    // 1. discovery file appears
    expect(existsSync(discoveryPath)).toBe(true);
    const discovery = JSON.parse(readFileSync(discoveryPath, "utf8")) as {
      pid: number;
      controlUrl: string;
      tokenFile: string;
    };
    expect(discovery.pid).toBe(running.proc.pid);
    expect(discovery.controlUrl).toBe(`http://127.0.0.1:${controlPort}`);
    expect(existsSync(discovery.tokenFile)).toBe(true);

    // 2. health ready
    const ready = await fetch(`${discovery.controlUrl}/health/ready`);
    expect(ready.status).toBe(200);

    // 3. client discovers and authenticates
    const client = await LitegresClient.connect({ runtimeDirOverride: runtimeDir });

    // 4. create a session
    const session = await client.createSession({ client: { name: "process-test" }, ttlSeconds: 1800 });
    expect(session.id.startsWith("ses_")).toBe(true);

    // 5. create a database
    const db = await client.createDatabase({ sessionId: session.id, ttlSeconds: 600 });
    expect(db.status).toBe("ready");

    // 6. an external PostgreSQL client connects over the wire
    const pgc = new pg.Client({
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.username,
      password: db.connection.password,
      connectionTimeoutMillis: 10_000,
    });
    await pgc.connect();
    const one = await pgc.query("SELECT 1 AS one");
    expect(one.rows[0]).toEqual({ one: 1 });
    await pgc.end();

    // 7. multiple databases can coexist
    const db2 = await client.createDatabase({ sessionId: session.id, ttlSeconds: 600 });
    expect(`${db2.connection.port}/${db2.connection.database}`).not.toBe(`${db.connection.port}/${db.connection.database}`);
    const status = await client.status();
    expect(status.activeDatabases).toBe(2);

    // 8. deleting a database closes its PostgreSQL endpoint
    await client.deleteDatabase(db.id);
    await expectEndpointClosed(db.connection);

    // 9. deleting a session closes all owned endpoints
    await client.deleteSession(session.id);
    await expectEndpointClosed(db2.connection);
    const after = await client.status();
    expect(after.activeDatabases).toBe(0);

    // 10. SIGTERM triggers graceful cleanup
    const code = await stopDaemon(running, "SIGTERM");
    expect(code).toBe(0);

    // 11. discovery files are removed, process exits
    expect(existsSync(discoveryPath)).toBe(false);
    expect(existsSync(join(runtimeDir, "token"))).toBe(false);
    running = null;
  }, 60_000);

  test("a second daemon cannot claim the same runtime dir", async () => {
    running = await startDaemon();
    const second = Bun.spawn([join(running.workDir, "litegresd"), "run"], {
      cwd: running.workDir,
      env: {
        ...process.env,
        ...(await pgEnv()),
        LITEGRES_RUNTIME_DIR: running.runtimeDir,
        LITEGRES_PORT: String(running.controlPort + 1),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(second.stderr).text();
    expect(stderr).toContain("owns");
    expect(stderr).toContain("litegres");
    await second.exited;
    running = null;
  }, 60_000);
});

async function expectEndpointClosed(conn: {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
}): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.username,
      password: conn.password,
      connectionTimeoutMillis: 300,
    });
    try {
      await client.connect();
      await client.end();
      await Bun.sleep(100);
    } catch {
      return;
    }
  }
  throw new Error(`${conn.host}:${conn.port}/${conn.database} still accepting connections`);
}
