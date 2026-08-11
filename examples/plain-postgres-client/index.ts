/**
 * Plain PostgreSQL client example.
 *
 * Shows the two planes working together:
 *   1. control plane — LitegresClient creates a session and a database
 *   2. data plane — an ordinary pg client runs SQL over the wire protocol
 *
 * Prerequisite: a running daemon (`litegresd run` in another terminal).
 */
import { LitegresClient } from "@litegres/client";
import pg from "pg";

const client = await LitegresClient.connect();

const session = await client.createSession({
  client: { name: "plain-postgres-client", framework: "example" },
});

const database = await client.createDatabase({
  sessionId: session.id,
  ttlSeconds: 600,
  initialization: {
    statements: [
      "CREATE TABLE accounts (id bigint primary key, name text not null)",
      "CREATE TABLE journal_entries (id bigserial primary key, account_id bigint, amount numeric)",
    ],
  },
});

console.log("control plane gave us:");
console.log(`  postgresUrl: ${database.connection.postgresUrl}`);
console.log(`  jdbcUrl:     ${database.connection.jdbcUrl}`);

// ---- data plane: entirely ordinary PostgreSQL ----
const pgClient = new pg.Client({
  host: database.connection.host,
  port: database.connection.port,
  database: database.connection.database,
  user: database.connection.username,
  password: database.connection.password,
});
await pgClient.connect();

await pgClient.query("INSERT INTO accounts VALUES (1, 'alice')");
await pgClient.query("INSERT INTO journal_entries (account_id, amount) VALUES (1, 100)");
const balance = await pgClient.query(`
  SELECT a.name, sum(j.amount) AS balance
  FROM accounts a JOIN journal_entries j ON j.account_id = a.id
  GROUP BY a.name
`);
console.log("data plane result:", JSON.stringify(balance.rows));
await pgClient.end();

// ---- teardown through the control plane ----
await client.deleteSession(session.id);
console.log("session deleted; all databases destroyed.");
