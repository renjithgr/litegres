/**
 * Injectable clock. The reaper and lease logic must use the clock so tests
 * can simulate expiration without sleeping.
 */
export interface Clock {
  /** Wall-clock now as a Date (UTC). */
  now(): Date;
  /** Wall-clock now in milliseconds. */
  nowMs(): number;
  /**
   * Monotonic time in milliseconds. Only elapsed-duration decisions should
   * use this; absolute timestamps must use nowMs().
   */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
  monotonicMs(): number {
    return performance.now();
  }
}

/** A clock whose wall time can be advanced manually (tests, reaper). */
export class ManualClock implements Clock {
  private wall: number;
  private mono: number;

  constructor(startMs: number = Date.parse("2026-08-06T17:00:00Z")) {
    this.wall = startMs;
    this.mono = 0;
  }

  now(): Date {
    return new Date(this.wall);
  }
  nowMs(): number {
    return this.wall;
  }
  monotonicMs(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}
