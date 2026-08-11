import { describe, expect, test } from "bun:test";
import { Metrics } from "../../src/observability/metrics";

describe("metrics", () => {
  test("counters and gauges accumulate", () => {
    const m = new Metrics();
    m.increment("a");
    m.increment("a", 2);
    m.setGauge("g", 5);
    const snap = m.snapshot();
    expect(snap.counters.a).toBe(3);
    expect(snap.gauges.g).toBe(5);
  });

  test("timings summarize", async () => {
    const m = new Metrics();
    await m.timed("op", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await m.timed("op", async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const snap = m.snapshot();
    expect(snap.timings.op!.count).toBe(2);
    expect(snap.timings.op!.minMs).toBeGreaterThanOrEqual(4);
    expect(snap.timings.op!.maxMs).toBeGreaterThanOrEqual(9);
    expect(snap.timings.op!.avgMs).toBeGreaterThanOrEqual(snap.timings.op!.minMs);
  });

  test("prometheus text exposes counters", () => {
    const m = new Metrics();
    m.increment("litegres_databases_created_total");
    const text = m.toPrometheusText();
    expect(text).toContain("litegres_databases_created_total 1");
  });
});
