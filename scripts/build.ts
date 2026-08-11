/**
 * Build the litegresd standalone executable.
 *
 * `bun build --compile` embeds every `{ type: "file" }` asset (the PGlite
 * WASM artifacts) into the binary; the daemon loads them from the embedded
 * $bunfs at runtime. PGLITE_VERSION is baked in via a define so /v1/status
 * reports it without probing node_modules.
 */
import { build } from "bun";
import { readFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const distDir = resolve(root, "dist");
const outfile = resolve(distDir, "litegresd");

function pgliteVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(root, "node_modules", "@electric-sql", "pglite", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

mkdirSync(distDir, { recursive: true });

const result = await build({
  entrypoints: [resolve(root, "src", "main.ts")],
  // compile mode writes the executable into outdir, named after the entry.
  outdir: distDir,
  compile: true,
  minify: true,
  sourcemap: "none",
  target: "bun",
  define: {
    __PGLITE_VERSION__: JSON.stringify(pgliteVersion()),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const produced = result.outputs.find((o) => o.path.endsWith(import.meta.dir.includes("scripts") ? "main" : "main"));
const outputPath = result.outputs[0]?.path;
if (outputPath && outputPath !== outfile) {
  renameSync(outputPath, outfile);
}

const size = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
console.log(`Built ${outfile} (${size} MiB), PGlite ${pgliteVersion()}`);
