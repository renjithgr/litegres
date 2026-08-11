/**
 * Credential generation and validation.
 *
 * PGlite authenticates with PostgreSQL's `trust` mechanism, so the password
 * is not enforced by the database itself; we still generate unpredictable
 * credentials so connection strings look and behave like ordinary PostgreSQL
 * ones, and so future auth work has a stable place to land.
 */
import { randomBytes } from "node:crypto";

export interface DatabaseCredentials {
  username: string;
  password: string;
}

export function generatePassword(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}

export function generateCredentials(): DatabaseCredentials {
  return { username: "postgres", password: generatePassword() };
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(username) && username.length <= 63;
}

export function isValidPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8 && password.length <= 256;
}

export function isValidTtlSeconds(ttl: number): boolean {
  return Number.isInteger(ttl) && ttl > 0;
}
