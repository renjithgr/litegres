/**
 * CLI output formatting: human-readable tables or JSON.
 */
export type OutputFormat = "human" | "json";

export interface OutputOptions {
  format: OutputFormat;
}

export function printResult(value: unknown, opts: OutputOptions): void {
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    printTable(value as Record<string, unknown>[]);
    return;
  }
  if (typeof value === "object") {
    printKeyValues(value as Record<string, unknown>);
    return;
  }
  process.stdout.write(String(value) + "\n");
}

export function printMessage(message: string, opts: OutputOptions): void {
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ message }) + "\n");
    return;
  }
  process.stdout.write(message + "\n");
}

function printKeyValues(obj: Record<string, unknown>): void {
  const rows = Object.entries(obj).filter(([k]) => !["connection", "metadata", "client", "provisioningDatabase"].includes(k));
  for (const [key, value] of rows) {
    process.stdout.write(`${key}: ${formatValue(value)}\n`);
  }
  if (obj.connection) {
    process.stdout.write("connection:\n");
    printKeyValues(obj.connection as Record<string, unknown>);
  }
  if (obj.provisioningDatabase) {
    process.stdout.write("provisioningDatabase:\n");
    printKeyValues(obj.provisioningDatabase as Record<string, unknown>);
  }
  if (obj.metadata && typeof obj.metadata === "object" && Object.keys(obj.metadata as object).length > 0) {
    process.stdout.write(`metadata: ${JSON.stringify(obj.metadata)}\n`);
  }
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const keys = Object.keys(rows[0]!).filter(
    (k) => !["metadata", "connection", "client"].includes(k),
  );
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((r) => String(r[key] ?? "").length)));
  process.stdout.write(keys.map((k, i) => k.padEnd(widths[i]!)).join("  ") + "\n");
  process.stdout.write(keys.map((k, i) => "-".repeat(widths[i]!)).join("  ") + "\n");
  for (const row of rows) {
    process.stdout.write(keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i]!)).join("  ") + "\n");
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
