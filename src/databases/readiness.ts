/**
 * PostgreSQL wire-protocol readiness checks.
 *
 * Readiness is verified with a real PostgreSQL client over TCP — never
 * through PGlite's direct JavaScript query API alone. The wire endpoint must
 * be usable by external clients before a database is reported ready.
 */
import pg from "pg";
import { ApiError } from "../api/errors";
import type { Clock } from "../clock";

export interface ReadinessTarget {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
}

export interface ReadinessResult {
  ok: boolean;
  serverVersion?: string;
  durationMs: number;
  error?: string;
}

export async function checkWireReadiness(
  target: ReadinessTarget,
  timeoutMs: number,
  clock?: Clock,
): Promise<ReadinessResult> {
  const start = (clock?.monotonicMs() ?? performance.now());
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password: target.password,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    ssl: false,
  });
  try {
    await client.connect();
    const res = await client.query("SELECT 1");
    const version = await client.query(
      "SELECT current_setting('server_version') AS version",
    );
    return {
      ok: res.rows.length === 1,
      serverVersion: version.rows[0]?.version as string | undefined,
      durationMs: Math.round((clock?.monotonicMs() ?? performance.now()) - start),
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Math.round((clock?.monotonicMs() ?? performance.now()) - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Readiness check that throws a structured ApiError on failure. */
export async function assertWireReadiness(
  target: ReadinessTarget,
  timeoutMs: number,
  context: { databaseId: string; host: string; port: number },
): Promise<string | undefined> {
  const result = await checkWireReadiness(target, timeoutMs);
  if (!result.ok) {
    throw new ApiError(
      "READINESS_CHECK_FAILED",
      `PostgreSQL wire endpoint for database ${context.databaseId} did not pass readiness.`,
      500,
      {
        host: context.host,
        port: context.port,
        error: result.error,
      },
    );
  }
  return result.serverVersion;
}
