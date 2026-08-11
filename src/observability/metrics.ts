/**
 * Minimal internal metrics registry: counters, gauges and histogram-style
 * timings. Exposed as JSON through /v1/status and the CLI; a Prometheus
 * endpoint is future work and deliberately not wired in.
 */

export interface MetricSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timings: Record<string, TimingSummary>;
}

export interface TimingSummary {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private timings = new Map<string, { values: number[] }>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, durationMs: number): void {
    const entry = this.timings.get(name) ?? { values: [] };
    entry.values.push(durationMs);
    this.timings.set(name, entry);
  }

  /** Time an async operation and record its duration in ms. */
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }

  snapshot(): MetricSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;

    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;

    const timings: Record<string, TimingSummary> = {};
    for (const [k, { values }] of this.timings) {
      if (values.length === 0) continue;
      const sum = values.reduce((a, b) => a + b, 0);
      timings[k] = {
        count: values.length,
        sumMs: round(sum),
        minMs: round(Math.min(...values)),
        maxMs: round(Math.max(...values)),
        avgMs: round(sum / values.length),
      };
    }
    return { counters, gauges, timings };
  }

  /** Prometheus-style text exposition (available, though not served by default). */
  toPrometheusText(): string {
    const snap = this.snapshot();
    const lines: string[] = [];
    for (const [k, v] of Object.entries(snap.counters)) {
      lines.push(`# TYPE ${k} counter`);
      lines.push(`${k} ${v}`);
    }
    for (const [k, v] of Object.entries(snap.gauges)) {
      lines.push(`# TYPE ${k} gauge`);
      lines.push(`${k} ${v}`);
    }
    for (const [k, v] of Object.entries(snap.timings)) {
      lines.push(`# TYPE ${k}_count counter`);
      lines.push(`${k}_count ${v.count}`);
      lines.push(`# TYPE ${k}_sum counter`);
      lines.push(`${k}_sum ${v.sumMs}`);
      lines.push(`# TYPE ${k} gauge`);
      lines.push(`${k} ${v.avgMs}`);
    }
    return lines.join("\n");
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
