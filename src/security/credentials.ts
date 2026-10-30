/**
 * Credential generation and validation.
 *
 * Control-plane tokens and passwords are generated here. (Database
 * connections themselves use the PostgreSQL server's own credentials.)
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
