/**
 * Template fingerprint handling.
 *
 * A fingerprint is a client-supplied stable identifier for a template's
 * contents (usually a hash of its migrations, e.g. `sha256:5f6a...`). It is
 * the idempotency key for PUT /v1/templates/{fingerprint}.
 */
import { ApiError } from "../api/errors";

const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._+\-]{1,255}$/;

export function isValidFingerprint(fingerprint: string): boolean {
  return typeof fingerprint === "string" && FINGERPRINT_PATTERN.test(fingerprint);
}

export function assertValidFingerprint(fingerprint: string): void {
  if (!isValidFingerprint(fingerprint)) {
    throw new ApiError(
      "INVALID_REQUEST",
      `Invalid template fingerprint "${fingerprint}". Expected 2-256 characters of [A-Za-z0-9:._+-].`,
      400,
      { fingerprint },
    );
  }
}
