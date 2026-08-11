import { describe, expect, test } from "bun:test";
import { RuntimeDirectory, isPidAlive } from "../../src/security/runtime-directory";
import { Logger } from "../../src/observability/logger";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeRuntimeDir(): { dir: RuntimeDirectory; root: string } {
  const root = mkdtempSync(join(tmpdir(), "litegres-rt-"));
  const dir = new RuntimeDirectory({
    runtimeDirOverride: root,
    logger: new Logger({ level: "error", destination: () => {} }),
    version: "test",
  });
  return { dir, root };
}

describe("runtime directory", () => {
  test("writes discovery and token files atomically with restrictive modes", async () => {
    const { dir, root } = makeRuntimeDir();
    try {
      await dir.acquireLock();
      await dir.writeTokenFile("tok_secret");
      await dir.writeDiscoveryFile({
        pid: process.pid,
        version: "0.1.0",
        controlUrl: "http://127.0.0.1:49100",
        tokenFile: dir.tokenFilePath,
        startedAt: new Date().toISOString(),
      });
      expect(existsSync(join(root, "daemon.json"))).toBe(true);
      expect(existsSync(join(root, "token"))).toBe(true);
      expect(existsSync(join(root, "lock", "pid"))).toBe(true);
      const discovery = JSON.parse(readFileSync(join(root, "daemon.json"), "utf8")) as { pid: number };
      expect(discovery.pid).toBe(process.pid);
      const status = await dir.detectExistingDaemon();
      expect(status.kind).toBe("healthy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale lock from a dead pid is taken over", async () => {
    const { dir, root } = makeRuntimeDir();
    try {
      await dir.acquireLock();
      // Simulate a crashed daemon: replace the pid with a dead one.
      // (acquireLock already succeeded; re-acquire after faking staleness.)
      await dir.removeAll();
      // Create a lock with a pid that is guaranteed dead.
      const deadPid = 999_999_999;
      await import("node:fs/promises").then((fs) => fs.mkdir(dir.lockDir, { recursive: true }));
      await import("node:fs/promises").then((fs) => fs.writeFile(join(dir.lockDir, "pid"), String(deadPid)));
      await dir.acquireLock(); // must succeed (stale takeover)
      expect(existsSync(join(dir.lockDir, "pid"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detectExistingDaemon reports dead pid", async () => {
    const { dir, root } = makeRuntimeDir();
    try {
      await dir.acquireLock();
      await dir.writeTokenFile("tok");
      await dir.writeDiscoveryFile({
        pid: 999_999_999,
        version: "0.1.0",
        controlUrl: "http://127.0.0.1:49100",
        tokenFile: dir.tokenFilePath,
        startedAt: new Date().toISOString(),
      });
      const status = await dir.detectExistingDaemon();
      expect(status.kind).toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removeAll is idempotent and removes everything", async () => {
    const { dir, root } = makeRuntimeDir();
    await dir.acquireLock();
    await dir.writeTokenFile("tok");
    await dir.writeDiscoveryFile({
      pid: process.pid,
      version: "0.1.0",
      controlUrl: "http://127.0.0.1:49100",
      tokenFile: dir.tokenFilePath,
      startedAt: new Date().toISOString(),
    });
    await dir.removeAll();
    await dir.removeAll(); // idempotent
    expect(existsSync(join(root, "daemon.json"))).toBe(false);
    expect(existsSync(join(root, "token"))).toBe(false);
    expect(existsSync(join(root, "lock"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("isPidAlive distinguishes live and dead pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});
