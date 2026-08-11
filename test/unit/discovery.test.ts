import { describe, expect, test } from "bun:test";
import { readDiscoveryFile, resolveRuntimeDir } from "../../clients/typescript/src/discovery";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("client discovery parsing", () => {
  test("reads a valid discovery file", () => {
    const root = mkdtempSync(join(tmpdir(), "litegres-disc-"));
    try {
      writeFileSync(
        join(root, "daemon.json"),
        JSON.stringify({ pid: 1234, version: "0.1.0", controlUrl: "http://127.0.0.1:49100", tokenFile: "/x/token", startedAt: "2026-01-01T00:00:00Z" }),
      );
      const discovery = readDiscoveryFile(root);
      expect(discovery?.pid).toBe(1234);
      expect(discovery?.controlUrl).toBe("http://127.0.0.1:49100");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing or malformed files return undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "litegres-disc-"));
    try {
      expect(readDiscoveryFile(root)).toBeUndefined();
      writeFileSync(join(root, "daemon.json"), "{not json");
      expect(readDiscoveryFile(root)).toBeUndefined();
      writeFileSync(join(root, "daemon.json"), JSON.stringify({ pid: "not-a-number" }));
      expect(readDiscoveryFile(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime dir resolution honors LITEGRES_RUNTIME_DIR then XDG_RUNTIME_DIR", () => {
    const prevL = process.env.LITEGRES_RUNTIME_DIR;
    const prevX = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.LITEGRES_RUNTIME_DIR = "/tmp/env-dir";
      expect(resolveRuntimeDir()).toBe("/tmp/env-dir");
      delete process.env.LITEGRES_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = "/run/user/1000";
      expect(resolveRuntimeDir()).toBe("/run/user/1000/litegres");
      expect(resolveRuntimeDir("/custom")).toBe("/custom");
    } finally {
      if (prevL) process.env.LITEGRES_RUNTIME_DIR = prevL;
      else delete process.env.LITEGRES_RUNTIME_DIR;
      if (prevX) process.env.XDG_RUNTIME_DIR = prevX;
      else delete process.env.XDG_RUNTIME_DIR;
    }
  });
});
