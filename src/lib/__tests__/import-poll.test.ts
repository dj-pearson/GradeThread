import { describe, it, expect } from "vitest";
import { decidePoll, nextPollDelay } from "@/lib/import-poll";

describe("import run polling cadence (IMP-02)", () => {
  it("polls every 2s for the first 10s, then every 5s", () => {
    expect(nextPollDelay(0)).toBe(2000);
    expect(nextPollDelay(9_999)).toBe(2000);
    expect(nextPollDelay(10_000)).toBe(5000);
    expect(nextPollDelay(120_000)).toBe(5000);
  });

  it("stays under 30 requests a minute over a 2-minute run", () => {
    let t = 0;
    let n = 0;
    const perMinute = [0, 0];
    while (t < 120_000) {
      perMinute[Math.floor(t / 60_000)]! += 1;
      n++;
      t += nextPollDelay(t);
    }
    expect(Math.max(...perMinute)).toBeLessThan(30);
    expect(n).toBeGreaterThan(0);
  });

  it("honors Retry-After on a 429", () => {
    expect(decidePoll(429, "20", 2000)).toEqual({ kind: "retry", delayMs: 20_000 });
    expect(decidePoll(429, null, 2000)).toEqual({ kind: "retry", delayMs: 10_000 });
  });

  it("stops on 403 and 404 with a message", () => {
    expect(decidePoll(403, null, 2000).kind).toBe("stop");
    expect(decidePoll(404, null, 2000).kind).toBe("stop");
  });

  it("keeps going on a 5xx at the normal cadence", () => {
    expect(decidePoll(502, null, 5000)).toEqual({ kind: "retry", delayMs: 5000 });
    expect(decidePoll(200, null, 5000)).toEqual({ kind: "ok" });
  });
});
