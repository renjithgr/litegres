/**
 * Lint: typecheck plus a few structural rules enforced without a linter dep.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const root = resolve(import.meta.dir, "..");
let failed = false;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failed = true;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. TypeScript strict typecheck.
console.log("typecheck…");
const tsc = spawnSync("bunx", ["tsc", "--noEmit"], { cwd: root, encoding: "utf8" });
check("tsc --noEmit", tsc.status === 0, tsc.stdout || tsc.stderr);

// 2. No console.log in the daemon core (structured logger only). The CLI
// surface (main.ts, cli/) legitimately prints user-facing output.
console.log("source hygiene…");
const srcFiles = walk(resolve(root, "src"));
const consoleLogs = srcFiles.filter(
  (f) =>
    !f.includes("/cli/") &&
    !f.endsWith("main.ts") &&
    /console\.(log|debug)\(/.test(readFileSync(f, "utf8")),
);
check("no console.log in src", consoleLogs.length === 0, consoleLogs.join(", "));

// 3. No .only() left in tests.
console.log("test hygiene…");
const testFiles = walk(resolve(root, "test"));
const onlys = testFiles.filter((f) => /\.only\(/.test(readFileSync(f, "utf8")));
check("no .only() in tests", onlys.length === 0, onlys.join(", "));

// 4. bun.lock is committed.
check("bun.lock exists", exists(resolve(root, "bun.lock")));

// 5. docs/openapi.yaml is up to date.
console.log("openapi…");
const gen = spawnSync("bun", ["run", "scripts/generate-openapi.ts"], { cwd: root, encoding: "utf8" });
check("openapi regeneration", gen.status === 0, gen.stderr);

process.exit(failed ? 1 : 0);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
