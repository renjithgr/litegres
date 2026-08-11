/**
 * Structured logger with mandatory secret redaction.
 *
 * Output is newline-delimited JSON to stdout (matching the style of
 * `Bun.serve`'s structured logs). A human-readable mode exists for `run`.
 */
import type { Clock } from "../clock";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "human";

export interface LogFields {
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Redact values that look like secrets: passwords in URLs, bare password
 * fields, tokens and lease tokens. Applied to every log record.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max-depth]";
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/pass(word)?|secret|token|credential/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function redactString(input: string): string {
  let s = input;
  // postgresql://user:password@host/...  (also jdbc:postgresql://...?...)
  s = s.replace(
    /(postgres(?:ql)?:\/\/[^:/\s]+:)[^@/\s]+(@)/gi,
    "$1[REDACTED]$2",
  );
  // jdbc URLs use ?password=... or &password=...
  s = s.replace(/([?&](?:password|pwd|passwd)=)[^&\s]+/gi, "$1[REDACTED]");
  // bare password= / token= assignments
  s = s.replace(/(\b(?:password|token|leaseToken|lease_token)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
  return s;
}

export class Logger {
  readonly level: LogLevel;
  readonly format: LogFormat;
  private clock: Clock;

  constructor(opts: {
    level?: LogLevel;
    format?: LogFormat;
    clock?: Clock;
    destination?: (line: string) => void;
  }) {
    this.level = opts.level ?? "info";
    this.format = opts.format ?? "json";
    this.clock = opts.clock ?? { now: () => new Date(), nowMs: () => Date.now(), monotonicMs: () => performance.now() };
    if (opts.destination) this.destination = opts.destination;
  }

  private destination: (line: string) => void = (line) => process.stdout.write(line + "\n");

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (!this.shouldLog(level)) return;
    const record = {
      time: this.clock.now().toISOString(),
      level,
      msg: message,
      ...fields,
    };
    const safe = redact(record);
    if (this.format === "human") {
      const parts = Object.entries(safe as Record<string, unknown>)
        .filter(([k]) => !["time", "level", "msg"].includes(k))
        .map(([k, v]) => `${k}=${formatHuman(v)}`);
      const line = `${record.time} ${level.toUpperCase().padEnd(5)} ${message}${parts.length ? "  " + parts.join(" ") : ""}`;
      this.destination(line);
    } else {
      this.destination(JSON.stringify(safe));
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  child(bindings: LogFields): Logger {
    const parent = this;
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "emit" || prop === "destination") {
          return (...args: unknown[]) => {
            const [level, message, fields] = args as [LogLevel, string, LogFields];
            parent.emit(level, message, { ...bindings, ...(fields ?? {}) });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Logger;
  }
}

function formatHuman(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(redact(v));
  return String(v);
}
