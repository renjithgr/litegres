/**
 * Baseline: boot one PGlite instance in a fresh process and close it.
 * Used by the benchmark to compare against in-process Litegres instances.
 */
import { createPglite } from "../src/packaging/pglite-assets";

const start = performance.now();
const db = await createPglite();
await db.waitReady;
await db.query("SELECT 1");
const bootMs = performance.now() - start;
await db.close();
console.log(JSON.stringify({ bootMs, rssMiB: Math.round(process.memoryUsage.rss() / 1024 / 1024) }));
