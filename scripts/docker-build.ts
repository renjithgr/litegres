/**
 * Build the Litegres Docker image.
 *
 * Usage:
 *   bun run docker-build            # tags litegres/litegresd:<version>
 *   bun run docker-build -- tag=v2  # tags litegres/litegresd:v2
 *
 * The image is pre-configured for Docker networking (see Dockerfile):
 * publish the control port and the data-plane range 1:1:
 *
 *   docker run --rm -p 49100:49100 -p 49152-49183:49152-49183 litegres/litegresd:<tag>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const tagArg = process.argv.find((a) => a.startsWith("tag="));
const tag = tagArg ? tagArg.slice("tag=".length) : version;
const image = `litegres/litegresd:${tag}`;

const { stdout, stderr, exitCode } = Bun.spawnSync([
  "docker",
  "build",
  "-t",
  image,
  root,
]);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (exitCode !== 0) {
  console.error(`docker build failed (exit ${exitCode})`);
  process.exit(exitCode ?? 1);
}
console.log(`Built ${image}`);
