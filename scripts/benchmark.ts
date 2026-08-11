/**
 * Benchmark Litegres creation/clone/delete paths.
 *
 * Measures:
 *   - daemon cold startup
 *   - empty database creation latency
 *   - template clone latency
 *   - database deletion latency
 *   - sequential and parallel creation throughput
 *   - process RSS by active database count
 *   - (optional) separate PGlite subprocess vs Testcontainers, when available
 *
 * Run: bun run scripts/benchmark.ts [--quick]
 */
import { Daemon } from "../src/daemon";
import { testConfig } from "../test/helpers";
import { LitegresClient } from "../clients/typescript/src/index";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(import.meta.dir, "..");
const quick = process.argv.includes("--quick");
const N = quick ? 3 : 8;

interface Timing {
  label: string;
  ms: number;
}

const results: Timing[] = [];

function record(label: string, ms: number): void {
  results.push({ label, ms });
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms`);
}

async function main(): Promise<void> {
  console.log("Litegres benchmark");
  console.log("=================");
  console.log(
    JSON.stringify(
      {
        machine: {
          platform: process.platform,
          arch: process.arch,
          cpu: (await Bun.file("/proc/cpuinfo").text().catch(() => "")).split("model name")[1]?.split("\n")[0]?.slice(1) ?? "n/a",
          cores: navigator.hardwareConcurrency,
          memory: process.memoryUsage.rss(),
        },
        runtime: { bun: Bun.version },
        mode: quick ? "quick" : "full",
      },
      null,
      2,
    ),
  );

  // --- daemon cold startup ---
  console.log("\n1. Daemon cold startup");
  const daemon = new Daemon({ config: testConfig({ logLevel: "error" }), noRuntimeDir: true });
  const t0 = performance.now();
  await daemon.start();
  record("daemon start (in-process)", performance.now() - t0);

  const client = LitegresClient.connectTo(daemon.controlUrl, daemon.controlToken);

  // --- empty database creation ---
  console.log("\n2. Empty database creation (sequential)");
  const emptyDbs: { id: string; port: number }[] = [];
  const createTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const db = await client.createDatabase({ ttlSeconds: 3600 });
    createTimes.push(performance.now() - s);
    emptyDbs.push({ id: db.id, port: db.connection.port });
  }
  const avgCreate = createTimes.reduce((a, b) => a + b, 0) / createTimes.length;
  record(`average create (n=${N})`, avgCreate);

  // --- RSS by active database count ---
  console.log("\n3. Process RSS by active database count");
  for (const db of emptyDbs) {
    const rss = process.memoryUsage.rss() / 1024 / 1024;
    console.log(`  ${String(db.port).padEnd(6)} active, rss ${rss.toFixed(0).padStart(7)} MiB`);
  }

  // --- template creation + clone ---
  console.log("\n4. Template creation and cloning");
  const ts = performance.now();
  const tpl = await client.putTemplate({
    fingerprint: `bench:${Date.now()}`,
    initialization: { statements: ["CREATE TABLE bench (id bigint primary key, payload text)"] },
  });
  record("template creation (statements)", performance.now() - ts);

  const cloneTimes: number[] = [];
  const clones: { id: string; port: number }[] = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const db = await client.createDatabase({ templateId: tpl.id, ttlSeconds: 3600 });
    cloneTimes.push(performance.now() - s);
    clones.push({ id: db.id, port: db.connection.port });
  }
  record(`average template clone (n=${N})`, cloneTimes.reduce((a, b) => a + b, 0) / cloneTimes.length);

  // --- deletion latency ---
  console.log("\n5. Deletion latency");
  const delTimes: number[] = [];
  for (const db of [...clones, ...emptyDbs]) {
    const s = performance.now();
    await client.deleteDatabase(db.id);
    delTimes.push(performance.now() - s);
  }
  record(`average delete (n=${delTimes.length})`, delTimes.reduce((a, b) => a + b, 0) / delTimes.length);

  // --- parallel creation throughput ---
  console.log("\n6. Parallel creation throughput");
  const p = performance.now();
  const parallel = await Promise.all(
    Array.from({ length: N }, () => client.createDatabase({ ttlSeconds: 3600 })),
  );
  const parallelMs = performance.now() - p;
  record(`parallel create (${N} at once)`, parallelMs);
  record(`throughput (db/s)`, N / (parallelMs / 1000));
  for (const db of parallel) await client.deleteDatabase(db.id);

  await daemon.shutdown("benchmark complete");

  // --- separate PGlite process baseline ---
  console.log("\n7. Separate PGlite process baseline (single boot)");
  const bootScript = resolve(root, "scripts", "_pglite-boot-baseline.ts");
  const s = performance.now();
  const proc = Bun.spawnSync(["bun", bootScript], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const baselineMs = performance.now() - s;
  if (proc.exitCode === 0) {
    record("PGlite boot + close (own process)", baselineMs);
  } else {
    console.log(`  (baseline failed: ${proc.stderr.toString().slice(0, 200)})`);
  }

  // --- Testcontainers, only when Docker is available ---
  console.log("\n8. PostgreSQL Testcontainer (Docker), when available");
  const docker = Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
  if (docker.exitCode === 0) {
    console.log("  Docker available; starting postgres:16-alpine container…");
    const start = performance.now();
    const run = Bun.spawnSync(
      ["docker", "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=bench", "-P", "postgres:16-alpine"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode === 0) {
      const containerId = run.stdout.toString().trim();
      const portOut = Bun.spawnSync(["docker", "port", containerId, "5432"], { stdout: "pipe" }).stdout.toString().trim();
      const hostPort = portOut.split("\n")[0]?.split(":")[1] ?? "?";
      record("container start + port ready", performance.now() - start);
      console.log(`  container ${containerId.slice(0, 12)} on host port ${hostPort}`);
      Bun.spawnSync(["docker", "stop", containerId], { stdout: "ignore" });
    } else {
      console.log(`  (docker run failed: ${run.stderr.toString().slice(0, 120)})`);
    }
  } else {
    console.log("  Docker not available — skipped.");
  }

  console.log("\nSummary (ms):");
  for (const r of results) console.log(`  ${r.label}: ${r.ms.toFixed(1)}`);
  console.log("\nThese numbers are machine-specific and not comparable across setups.");
}

await main();
process.exit(0);
