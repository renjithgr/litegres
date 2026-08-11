import { describe, expect, test } from "bun:test";
import { Logger, redact, redactString } from "../../src/observability/logger";

describe("log redaction", () => {
  test("passwords in URLs are redacted", () => {
    expect(redactString("postgresql://postgres:supersecret@127.0.0.1:5432/db")).toContain("[REDACTED]");
    expect(redactString("postgresql://postgres:supersecret@127.0.0.1:5432/db")).not.toContain("supersecret");
  });

  test("jdbc passwords are redacted", () => {
    expect(redactString("jdbc:postgresql://127.0.0.1:5432/db?password=hunter2&sslmode=disable")).not.toContain("hunter2");
  });

  test("token-ish keys are redacted in objects", () => {
    const out = redact({ leaseToken: "tok_abc", password: "p", databaseId: "db_1" }) as Record<string, unknown>;
    expect(out.leaseToken).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.databaseId).toBe("db_1");
  });

  test("structured log lines carry fields", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "info", format: "json", destination: (l) => lines.push(l) });
    logger.info("hello", { databaseId: "db_1", sessionId: "ses_1", duration: 12 });
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.msg).toBe("hello");
    expect(record.level).toBe("info");
    expect(record.databaseId).toBe("db_1");
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("log level filtering works", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "warn", format: "json", destination: (l) => lines.push(l) });
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("shown");
  });

  test("human format works", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "info", format: "human", destination: (l) => lines.push(l) });
    logger.info("started", { port: 49100 });
    expect(lines[0]).toContain("started");
    expect(lines[0]).toContain("port=49100");
  });
});
