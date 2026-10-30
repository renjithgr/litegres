/**
 * Package the built executable into a self-contained archive.
 *
 * The compiled litegresd binary is self-contained, so a tarball with just the
 * binary works from any clean directory (it still needs a PostgreSQL server or
 * Docker at run time; see README).
 */
import { build } from "bun";
import { readFileSync, mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const platform = `${process.platform}-${process.arch}`;
const distDir = resolve(root, "dist");
const staging = resolve(distDir, "package");
const binary = resolve(distDir, "litegresd");

mkdirSync(staging, { recursive: true });

// Ensure the binary exists (compile mode writes into outdir; rename to binary).
await build({
  entrypoints: [resolve(root, "src", "main.ts")],
  outdir: distDir,
  compile: true,
  minify: true,
  sourcemap: "none",
  target: "bun",
});
if (!existsSync(binary)) {
  const produced = resolve(distDir, "main");
  if (existsSync(produced)) renameSync(produced, binary);
}

// Copy the binary plus minimal metadata into a staging dir.
await Bun.$`cp ${binary} ${staging}/litegresd`.quiet();
await Bun.write(
  resolve(staging, "README.txt"),
  `Litegres ${version} (${platform})\n\nRun ./litegresd run to start the daemon.`,
);

// Archive.
const archive = resolve(distDir, `litegres-${version}-${platform}.tar.gz`);
await Bun.$`tar -czf ${archive} -C ${distDir} package`.quiet();
rmSync(staging, { recursive: true, force: true });

console.log(`Packaged ${archive}`);
