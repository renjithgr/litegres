/**
 * Sortable, ULID-style identifiers backed by a UUIDv7 layout.
 *
 * A UUIDv7 is a 128-bit value whose most significant 48 bits are a Unix
 * epoch millisecond timestamp, followed by 74 bits of randomness. We
 * Crockford-base32-encode those 16 bytes, which yields a 26-character
 * ULID-shaped identifier that sorts lexicographically by creation time.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD =
  "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U

export function uuidv7Bytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const now = Date.now();
  // 48-bit millisecond timestamp (big-endian) at bytes 0..5
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  randomBytes(10).forEach((byte, i) => {
    bytes[6 + i] = byte;
  });
  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

export function uuidv7(): string {
  const b = uuidv7Bytes();
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Crockford-base32-encode 16 bytes into a 26-char ULID-shaped string. */
export function toUlid(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31]!;
  }
  return out;
}

export type IdPrefix =
  | "db"
  | "tpl"
  | "ses"
  | "req"
  | "tok"
  | "job";

/** Generate a prefixed, time-ordered public identifier, e.g. `db_01J2YZ...`. */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${toUlid(uuidv7Bytes())}`;
}

/** Generate an unpredictable secret token (base64url, 32 bytes of entropy). */
export function generateSecretToken(prefix: IdPrefix = "tok"): string {
  const bytes = randomBytes(32);
  const b64 = Buffer.from(bytes).toString("base64url");
  return `${prefix}_${b64}`;
}
