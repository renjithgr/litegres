/**
 * Build the litegresd standalone executable (`bun build --compile`).
 */
import { build } from "bun";
import { mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const distDir = resolve(root, "dist");
const outfile = resolve(distDir, "litegresd");

mkdirSync(distDir, { recursive: true });

const result = await build({
  entrypoints: [resolve(root, "src", "main.ts")],
  // compile mode writes the executable into outdir, named after the entry.
  outdir: distDir,
  compile: true,
  minify: true,
  sourcemap: "none",
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outputPath = result.outputs[0]?.path;
if (outputPath && outputPath !== outfile) {
  renameSync(outputPath, outfile);
}

const size = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
console.log(`Built ${outfile} (${size} MiB)`);
