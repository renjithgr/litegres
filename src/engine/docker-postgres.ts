/**
 * Daemon-managed PostgreSQL container.
 *
 * Used when no `--postgres-url` is given. Starts one `postgres` container
 * bound to a random loopback port, tuned for throwaway test data
 * (`fsync=off` etc.), and removes it again on shutdown. An already-running
 * container from a previous daemon is reused and never stopped by us.
 */
import pg from "pg";
import { ApiError } from "../api/errors";
import type { Logger } from "../observability/logger";

export interface DockerPostgres {
  /** Admin connection URL for the container. */
  url: string;
  stop(): Promise<void>;
}

const CONTAINER_NAME = "litegres-postgres";
const PASSWORD = "litegres"; // loopback-only, disposable test server
const READY_TIMEOUT_MS = 60_000;

async function docker(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, out: (out + err).trim() };
  } catch (err) {
    return { ok: false, out: (err as Error).message };
  }
}

export async function startDockerPostgres(opts: {
  image: string;
  keep: boolean;
  logger: Logger;
}): Promise<DockerPostgres> {
  const { logger } = opts;
  const version = await docker("version", "--format", "{{.Server.Version}}");
  if (!version.ok) {
    throw new ApiError(
      "INVALID_CONFIGURATION",
      "No PostgreSQL server configured and Docker is not available. Pass --postgres-url (or LITEGRES_POSTGRES_URL) or start Docker. " +
        `(docker: ${version.out})`,
      500,
    );
  }

  let owned = false;
  const state = await docker("inspect", "--format", "{{.State.Running}}", CONTAINER_NAME);
  if (state.ok && state.out === "true") {
    logger.info("reusing running postgres container", { container: CONTAINER_NAME });
  } else {
    if (state.ok) await docker("rm", "-f", CONTAINER_NAME);
    const run = await docker(
      "run", "-d", "--name", CONTAINER_NAME,
      "--label", "litegres.managed=true",
      "-p", "127.0.0.1::5432",
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
      opts.image,
      "-c", "fsync=off",
      "-c", "synchronous_commit=off",
      "-c", "full_page_writes=off",
      "-c", "max_connections=300",
    );
    if (!run.ok) {
      throw new ApiError("INVALID_CONFIGURATION", `Could not start ${opts.image}: ${run.out}`, 500);
    }
    owned = true;
    logger.info("started postgres container", { container: CONTAINER_NAME, image: opts.image });
  }

  const stop = async () => {
    if (owned && !opts.keep) {
      await docker("rm", "-f", CONTAINER_NAME);
    }
  };

  try {
    const portOut = await docker("port", CONTAINER_NAME, "5432/tcp");
    const match = /:(\d+)\s*$/m.exec(portOut.out);
    if (!portOut.ok || !match) {
      throw new Error(`could not determine the published port (${portOut.out})`);
    }
    const url = `postgresql://postgres:${PASSWORD}@127.0.0.1:${match[1]}/postgres`;
    await waitUntilAcceptingConnections(url);
    return { url, stop };
  } catch (err) {
    await stop();
    throw new ApiError(
      "INVALID_CONFIGURATION",
      `Postgres container did not become ready: ${(err as Error).message}`,
      500,
    );
  }
}

/**
 * Wait on the published TCP port rather than `pg_isready`: the official
 * image runs a socket-only bootstrap server first, which pg_isready
 * already reports as ready.
 */
async function waitUntilAcceptingConnections(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (err) {
      last = (err as Error).message;
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`timed out after ${READY_TIMEOUT_MS}ms (${last})`);
}
