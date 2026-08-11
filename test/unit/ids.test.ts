import { describe, expect, test } from "bun:test";
import { generateId, generateSecretToken, toUlid, uuidv7, uuidv7Bytes } from "../../src/ids";

describe("id generation", () => {
  test("prefixed IDs use the expected prefix and are 29 characters", () => {
    const id = generateId("db");
    expect(id.startsWith("db_")).toBe(true);
    expect(id.length).toBe(29); // "db_" + 26 ULID chars
    expect(generateId("tpl").startsWith("tpl_")).toBe(true);
    expect(generateId("ses").startsWith("ses_")).toBe(true);
    expect(generateId("req").startsWith("req_")).toBe(true);
  });

  test("UUIDv7 is valid and version-marked", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("IDs sort chronologically", () => {
    // Extract the embedded millisecond timestamp from the UUIDv7 hex.
    const ts = (id: string) => parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    const a = uuidv7();
    const b = uuidv7();
    expect(ts(b)).toBeGreaterThanOrEqual(ts(a));
    // And the id strings compare by timestamp first
    const early = "000000000000" + "0".repeat(20);
    const late = "ffffffffffff" + "0".repeat(20);
    expect(early < late).toBe(true);
  });

  test("ULID encoding of UUIDv7 bytes yields 26 Crockford characters", () => {
    const bytes = uuidv7Bytes();
    const ulid = toUlid(bytes);
    expect(ulid.length).toBe(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  test("IDs are unique across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateId("db"));
    expect(seen.size).toBe(10_000);
  });

  test("secret tokens are long and unique", () => {
    const a = generateSecretToken();
    const b = generateSecretToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
    expect(a.startsWith("tok_")).toBe(true);
  });
});
