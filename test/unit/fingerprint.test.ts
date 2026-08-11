import { describe, expect, test } from "bun:test";
import { isValidFingerprint, assertValidFingerprint } from "../../src/templates/fingerprint";
import { ApiError } from "../../src/api/errors";

describe("fingerprints", () => {
  test("valid fingerprints pass", () => {
    expect(isValidFingerprint("sha256:5f6a")).toBe(true);
    expect(isValidFingerprint("brisk-core-v12")).toBe(true);
    expect(isValidFingerprint("git:abc123")).toBe(true);
    expect(isValidFingerprint("ab")).toBe(true);
  });

  test("invalid fingerprints fail", () => {
    expect(isValidFingerprint("")).toBe(false);
    expect(isValidFingerprint("has space")).toBe(false);
    expect(isValidFingerprint("has/slash")).toBe(false);
    expect(isValidFingerprint("x".repeat(300))).toBe(false);
    expect(() => assertValidFingerprint("bad fingerprint!")).toThrow(ApiError);
  });
});
