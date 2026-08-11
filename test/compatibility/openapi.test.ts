import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { buildOpenApiDocument } from "../../src/api/openapi";

const root = resolve(import.meta.dir, "..", "..");

describe("OpenAPI specification", () => {
  test("docs/openapi.yaml exists and parses as valid YAML", () => {
    const text = readFileSync(resolve(root, "docs", "openapi.yaml"), "utf8");
    const doc = YAML.parse(text) as Record<string, unknown>;
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.info as { title?: string }).title).toBe("Litegres Control API");
  });

  test("docs/openapi.yaml matches the in-code document", () => {
    const fromFile = YAML.parse(readFileSync(resolve(root, "docs", "openapi.yaml"), "utf8"));
    const fromCode = buildOpenApiDocument("0.1.0");
    expect(fromFile).toEqual(fromCode);
  });

  test("the specification covers all required endpoints", () => {
    const doc = buildOpenApiDocument("0.1.0");
    const paths = Object.keys(doc.paths as Record<string, unknown>);
    for (const required of [
      "/health/live",
      "/health/ready",
      "/v1/status",
      "/v1/sessions",
      "/v1/sessions/{sessionId}",
      "/v1/sessions/{sessionId}/renew",
      "/v1/databases",
      "/v1/databases/{databaseId}",
      "/v1/databases/{databaseId}/renew",
      "/v1/databases/{databaseId}/exec",
      "/v1/templates",
      "/v1/templates/{fingerprint}",
      "/v1/templates/{templateId}",
      "/v1/templates/{templateId}/finalize",
      "/v1/gc",
      "/v1/shutdown",
    ]) {
      expect(paths).toContain(required);
    }
  });

  test("security schemes cover daemon and lease tokens", () => {
    const doc = buildOpenApiDocument("0.1.0");
    const schemes = (doc.components as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes.daemonToken).toBeDefined();
    expect(schemes.leaseToken).toBeDefined();
  });

  test("error schema is present", () => {
    const doc = buildOpenApiDocument("0.1.0");
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    expect(schemas.Error).toBeDefined();
  });
});
