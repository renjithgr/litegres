/**
 * Generate docs/openapi.yaml from the single source of truth
 * (src/api/openapi.ts). Run: bun run scripts/generate-openapi.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { buildOpenApiDocument } from "../src/api/openapi";

const root = resolve(import.meta.dir, "..");
const doc = buildOpenApiDocument("0.1.0");
mkdirSync(resolve(root, "docs"), { recursive: true });
writeFileSync(resolve(root, "docs", "openapi.yaml"), YAML.stringify(doc));
console.log("Wrote docs/openapi.yaml");
