/**
 * Test preload: tests routinely start several daemons without closing them,
 * so drop every database a test daemon left behind after each test file.
 * (The PostgreSQL server itself comes from test/helpers.ts.)
 */
import { afterAll } from "bun:test";
import pg from "pg";

async function sweep(): Promise<void> {
  const url = process.env.LITEGRES_TEST_POSTGRES_URL;
  if (!url) return; // no database test ran yet
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const res = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, 'litegres_test_') OR starts_with(datname, 'litegres_proc_')",
    );
    for (const { datname } of res.rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

afterAll(sweep);
