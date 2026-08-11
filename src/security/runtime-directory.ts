/**
 * Runtime directory: discovery file, token file, and single-daemon locking.
 *
 * Layout (inside $XDG_RUNTIME_DIR/litegres or a platform fallback):
 *   daemon.json   - discovery file (pid, controlUrl, tokenFile, startedAt)
 *   token         - the daemon control token (chmod 600)
 *   lock/         - lock directory containing `pid` (atomic mkdir-based lock)
 *
 * All files are written atomically (temp file + rename) with restrictive
 * permissions. A stale lock (dead PID) is taken over.
 */
import { ApiError } from "../api/errors";
import type { Logger } from "../observability/logger";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface DiscoveryFile {
  pid: number;
  version: string;
  controlUrl: string;
  tokenFile: string;
  startedAt: string;
}

export type ExistingDaemonStatus =
  | { kind: "healthy"; pid: number; discovery: DiscoveryFile }
  | { kind: "dead"; pid: number }
  | { kind: "inaccessible"; error: string }
  | { kind: "stale" }
  | { kind: "absent" };

export interface RuntimeDirectoryDeps {
  runtimeDirOverride?: string;
  logger: Logger;
  version: string;
}

export class RuntimeDirectory {
  readonly root: string;
  readonly daemonFilePath: string;
  readonly tokenFilePath: string;
  readonly lockDir: string;
  private logger: Logger;
  private version: string;

  constructor(deps: RuntimeDirectoryDeps) {
    this.logger = deps.logger;
    this.version = deps.version;
    this.root = resolveRuntimeDir(deps.runtimeDirOverride);
    this.daemonFilePath = join(this.root, "daemon.json");
    this.tokenFilePath = join(this.root, "token");
    this.lockDir = join(this.root, "lock");
  }

  async ensureDir(): Promise<void> {
    await Bun.$`mkdir -p ${this.root}`.quiet();
    await chmodDir(this.root);
  }

  /**
   * Acquire the single-daemon lock. Throws DAEMON_ALREADY_RUNNING when a
   * live daemon owns the runtime directory; takes over stale locks.
   */
  async acquireLock(): Promise<void> {
    await this.ensureDir();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await Bun.$`mkdir ${this.lockDir}`.quiet();
        await Bun.write(join(this.lockDir, "pid"), String(process.pid));
        await chmodDir(this.lockDir);
        return;
      } catch (err) {
        // Lock exists; is the owner alive?
        const ownerPid = await this.readLockPid();
        if (ownerPid !== undefined && isPidAlive(ownerPid)) {
          throw new ApiError(
            "DAEMON_ALREADY_RUNNING",
            `Another Litegres daemon (pid ${ownerPid}) owns ${this.root}.`,
            409,
            { pid: ownerPid, runtimeDir: this.root },
          );
        }
        // Stale lock: remove and retry once.
        await Bun.$`rm -rf ${this.lockDir}`.quiet();
      }
    }
    throw new ApiError(
      "DAEMON_ALREADY_RUNNING",
      `Could not acquire the Litegres lock at ${this.lockDir}.`,
      409,
    );
  }

  private async readLockPid(): Promise<number | undefined> {
    try {
      const content = await Bun.file(join(this.lockDir, "pid")).text();
      const pid = Number(content.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** Write the control token file (chmod 600, atomic). */
  async writeTokenFile(token: string): Promise<void> {
    await atomicWrite(this.tokenFilePath, token);
  }

  /** Write the discovery file (chmod 600, atomic). */
  async writeDiscoveryFile(discovery: DiscoveryFile): Promise<void> {
    await atomicWrite(this.daemonFilePath, JSON.stringify(discovery, null, 2) + "\n");
  }

  async readDiscoveryFile(): Promise<DiscoveryFile | undefined> {
    try {
      const text = await Bun.file(this.daemonFilePath).text();
      const parsed = JSON.parse(text) as Partial<DiscoveryFile>;
      if (typeof parsed.pid !== "number" || typeof parsed.controlUrl !== "string") {
        return undefined;
      }
      return parsed as DiscoveryFile;
    } catch {
      return undefined;
    }
  }

  /**
   * Inspect the current state of the runtime directory without touching it.
   * Used by `litegresd status` and by the daemon at startup.
   */
  async detectExistingDaemon(): Promise<ExistingDaemonStatus> {
    const discovery = await this.readDiscoveryFile();
    if (!discovery) {
      const lockPid = await this.readLockPid();
      if (lockPid !== undefined && isPidAlive(lockPid)) {
        return { kind: "healthy", pid: lockPid, discovery: undefined as unknown as DiscoveryFile };
      }
      return { kind: "absent" };
    }
    if (isPidAlive(discovery.pid)) {
      return { kind: "healthy", pid: discovery.pid, discovery };
    }
    return { kind: "dead", pid: discovery.pid };
  }

  /** Remove discovery/token files and the lock. Idempotent. */
  async removeAll(): Promise<void> {
    for (const file of [this.daemonFilePath, this.tokenFilePath]) {
      await Bun.$`rm -f ${file}`.quiet();
    }
    await Bun.$`rm -rf ${this.lockDir}`.quiet();
  }
}

export function resolveRuntimeDir(override?: string): string {
  if (override) return override;
  const envDir = process.env.LITEGRES_RUNTIME_DIR;
  if (envDir) return envDir;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "litegres");
  const home = homedir();
  if (home) return join(home, ".local", "state", "litegres");
  return join(tmpdir(), `litegres-${process.getuid?.() ?? 0}`);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists but owned by another user
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await Bun.write(tmp, content);
  try {
    await Bun.$`chmod 600 ${tmp}`.quiet();
    await Bun.$`mv ${tmp} ${path}`.quiet();
  } catch (err) {
    await Bun.$`rm -f ${tmp}`.quiet();
    throw err;
  }
}

async function chmodDir(path: string): Promise<void> {
  await Bun.$`chmod 700 ${path}`.quiet().catch(() => {});
}
