/**
 * Test preload: when running against the native engine, drop every database
 * a test daemon left behind (tests routinely start several daemons without
 * closing them) before and after each test file.
 */
import { afterAll, beforeAll } from "bun:test";
import pg from "pg";

const url = process.env.LITEGRES_TEST_POSTGRES_URL;

async function sweep(): Promise<void> {
  if (!url) return;
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const res = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, 'litegres_test_')",
    );
    for (const { datname } of res.rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

beforeAll(sweep);
afterAll(sweep);
