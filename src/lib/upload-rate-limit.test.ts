import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  RateLimitedError,
  SlidingWindowLimiter,
} from "./upload-rate-limit";

describe("SlidingWindowLimiter", () => {
  it("lets the first maxRequests start immediately, then paces", () => {
    const now = 0;
    const limiter = new SlidingWindowLimiter(3, 60_000, () => now);
    expect(limiter.acquireDelayMs()).toBe(0);
    expect(limiter.acquireDelayMs()).toBe(0);
    expect(limiter.acquireDelayMs()).toBe(0);
    // 4th within the same instant must wait a full window (slot of start #1).
    expect(limiter.acquireDelayMs()).toBe(60_000);
    // 5th queues behind start #2's slot — also 60s from t=0.
    expect(limiter.acquireDelayMs()).toBe(60_000);
  });

  it("frees capacity as the window slides", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(limiter.acquireDelayMs()).toBe(0); // t=0
    now = 30_000;
    expect(limiter.acquireDelayMs()).toBe(0); // t=30s
    now = 45_000;
    // Window [t-60s, t] holds both starts → wait until t=0's start ages out.
    expect(limiter.acquireDelayMs()).toBe(15_000);
    now = 70_000;
    // t=0 start has aged out; window holds 30s + the reserved 60s slot → the
    // next slot opens when the 30s start ages out at t=90s.
    expect(limiter.acquireDelayMs()).toBe(20_000);
  });

  it("a 600-photo burst schedules ≤ max starts per window", () => {
    const now = 0;
    const max = 100;
    const windowMs = 60_000;
    const limiter = new SlidingWindowLimiter(max, windowMs, () => now);
    const startTimes: number[] = [];
    for (let i = 0; i < 600; i++) {
      startTimes.push(now + limiter.acquireDelayMs());
    }
    // Every sliding window of 60s must contain at most `max` starts.
    const sorted = [...startTimes].sort((a, b) => a - b);
    for (let i = 0; i + max < sorted.length; i++) {
      expect(sorted[i + max]! - sorted[i]!).toBeGreaterThanOrEqual(windowMs);
    }
    // And the whole batch completes in ~6 windows, not unbounded.
    expect(sorted[sorted.length - 1]!).toBeLessThanOrEqual(6 * windowMs);
  });

  it("never lets a later acquisition schedule before an earlier one", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 10_000, () => now);
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      const at = now + limiter.acquireDelayMs();
      expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
      now += 1_000;
    }
  });
});

describe("backoffDelayMs", () => {
  it("prefers the server's Retry-After when present", () => {
    // random() = 0 → no jitter, exact base.
    expect(backoffDelayMs(0, 7, () => 0)).toBe(7_000);
    expect(backoffDelayMs(3, 7, () => 0)).toBe(7_000);
  });

  it("falls back to capped exponential growth", () => {
    expect(backoffDelayMs(0, null, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, null, () => 0)).toBe(2_000);
    expect(backoffDelayMs(2, null, () => 0)).toBe(4_000);
    expect(backoffDelayMs(10, null, () => 0)).toBe(30_000); // cap
  });

  it("adds bounded jitter (≤ 25% of base)", () => {
    const withMaxJitter = backoffDelayMs(0, null, () => 1);
    expect(withMaxJitter).toBe(1_250);
    for (let i = 0; i < 20; i++) {
      const d = backoffDelayMs(0, null);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(1_250);
    }
  });
});

describe("RateLimitedError", () => {
  it("carries the server's Retry-After for the backoff", () => {
    expect(new RateLimitedError(12).retryAfterSeconds).toBe(12);
    expect(new RateLimitedError(null).retryAfterSeconds).toBeNull();
  });
});
