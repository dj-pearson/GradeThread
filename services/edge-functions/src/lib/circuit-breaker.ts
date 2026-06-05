// Timeouts + circuit breakers for external dependencies (US-499).
//
// A hung upstream (eBay/Stripe/Anthropic) is worse than a fast failure: requests
// pile up, the event loop fills with stalled fetches, and a bulk job or cron can
// exhaust the container. Two primitives guard against that:
//
//   fetchWithTimeout — a fetch with a hard deadline (AbortController). NO call
//     to an external host should be able to hang forever.
//   CircuitBreaker   — after N consecutive failures a breaker OPENS and
//     short-circuits further calls for a cooldown, so we stop hammering a
//     dependency that's already down (and the reprice/sync crons back off too).
//
// Breakers are in-memory and per-replica — good enough: each replica protecting
// itself from a hung dependency is the goal, and a shared/distributed breaker
// would add a DB round-trip to the very path we're trying to keep fast. State
// transitions are reported to the error tracker (US-491) so an open breaker is
// visible.

import { captureException, recordMetric } from "./observability.ts";

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// fetch with a hard deadline. On timeout the request is aborted and a
// TimeoutError is thrown (which isRetryableError matches, so withRetry retries).
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new TimeoutError(
        `Request timed out after ${timeoutMs}ms: ${describeTarget(input)}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function describeTarget(input: string | URL | Request): string {
  try {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

// ── Circuit breaker ─────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(public readonly breaker: string) {
    super(`Circuit breaker '${breaker}' is open`);
    this.name = "CircuitOpenError";
  }
}

export interface BreakerOptions {
  /** Consecutive failures before the breaker opens. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before a half-open probe. Default 30s. */
  cooldownMs?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
  /**
   * Which errors count toward opening the breaker. Default: everything. For an
   * upstream like eBay, pass isRetryableError so a CLIENT error (4xx — a revoked
   * token, a bad request) is treated as "dependency is up, just said no" and
   * does NOT trip the breaker; only 5xx/429/timeouts/network do.
   */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly isFailure: (err: unknown) => boolean;

  constructor(public readonly name: string, opts: BreakerOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? 5);
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.isFailure = opts.isFailure ?? (() => true);
  }

  getState(): BreakerState {
    // Lazily transition open → half_open once the cooldown elapses.
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half_open";
    }
    return this.state;
  }

  /**
   * Run `fn` under the breaker. Throws CircuitOpenError WITHOUT calling `fn`
   * when the breaker is open and still cooling down. A success closes the
   * breaker; a failure increments the counter and may open it. CircuitOpenError
   * itself never counts as a failure.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "open") {
      recordMetric("circuit.short_circuit", 1, { breaker: this.name });
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      // A non-counted error (e.g. a 4xx client error) means the dependency IS
      // responding — treat it like a success for breaker purposes (closes a
      // half-open probe) but still propagate the error to the caller.
      if (this.isFailure(err)) this.onFailure();
      else this.onSuccess();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state !== "closed") {
      recordMetric("circuit.close", 1, { breaker: this.name });
    }
    this.state = "closed";
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures += 1;
    // A failed half-open probe re-opens immediately; otherwise open once the
    // consecutive-failure threshold is crossed.
    if (this.state === "half_open" || this.failures >= this.threshold) {
      const wasOpen = this.state === "open";
      this.state = "open";
      this.openedAt = this.now();
      if (!wasOpen) {
        recordMetric("circuit.open", 1, { breaker: this.name });
        captureException(
          new Error(`Circuit breaker '${this.name}' opened after ${this.failures} failures`),
          { level: "warn", route: "circuit-breaker", tags: { breaker: this.name } },
        );
      }
    }
  }

  /** Test-only: reset to closed. */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.openedAt = 0;
  }
}

// Shared per-key registry so all callers (request paths AND crons) share one
// breaker per dependency — a cron tripping the eBay breaker also protects the
// interactive path, and vice-versa.
const registry = new Map<string, CircuitBreaker>();

export function getBreaker(key: string, opts?: BreakerOptions): CircuitBreaker {
  let b = registry.get(key);
  if (!b) {
    b = new CircuitBreaker(key, opts);
    registry.set(key, b);
  }
  return b;
}

// Test-only: clear all breakers between tests.
export function _clearBreakers(): void {
  registry.clear();
}
