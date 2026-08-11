/**
 * Daemon discovery: locate a running Litegres daemon and its control token.
 *
 * The daemon writes $XDG_RUNTIME_DIR/litegres/daemon.json (or a platform
 * fallback) plus a token file. This module reads both, without depending on
 * any daemon code.
 */
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface DiscoveryFile {
  pid: number;
  version: string;
  controlUrl: string;
  tokenFile: string;
  startedAt: string;
}

export interface DiscoveredDaemon {
  discovery: DiscoveryFile;
  token: string;
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

export function readDiscoveryFile(runtimeDir: string): DiscoveryFile | undefined {
  const path = join(runtimeDir, "daemon.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DiscoveryFile>;
    if (typeof parsed.pid !== "number" || typeof parsed.controlUrl !== "string") {
      return undefined;
    }
    return parsed as DiscoveryFile;
  } catch {
    return undefined;
  }
}

export function readTokenFile(runtimeDir: string): string | undefined {
  const discovery = readDiscoveryFile(runtimeDir);
  if (!discovery) return undefined;
  const tokenPath = discovery.tokenFile ?? join(runtimeDir, "token");
  if (!existsSync(tokenPath)) return undefined;
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** Locate a running daemon. Throws a descriptive Error when absent. */
export function discoverDaemon(opts: { runtimeDirOverride?: string } = {}): DiscoveredDaemon {
  const runtimeDir = resolveRuntimeDir(opts.runtimeDirOverride);
  const discovery = readDiscoveryFile(runtimeDir);
  if (!discovery) {
    throw new Error(
      `No Litegres daemon discovery file found at ${join(runtimeDir, "daemon.json")}. ` +
        "Start the daemon with `litegresd run` first.",
    );
  }
  if (!isPidAlive(discovery.pid)) {
    throw new Error(
      `The Litegres daemon recorded in ${join(runtimeDir, "daemon.json")} (pid ${discovery.pid}) is not running. ` +
        "Start the daemon with `litegresd run` first.",
    );
  }
  const token = readTokenFile(runtimeDir);
  if (!token) {
    throw new Error(
      `No Litegres control token found at ${discovery.tokenFile}. ` +
        "Start the daemon with `litegresd run` first.",
    );
  }
  return { discovery, token };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
