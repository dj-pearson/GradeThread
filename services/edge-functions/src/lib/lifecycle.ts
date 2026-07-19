// US-2010: graceful shutdown — stop claiming NEW work, let in-flight work finish.
//
// The edge runs as a single Coolify container with NO signal handling at all, so
// a deploy SIGKILLs in-flight requests rather than draining them. The accounting
// survives that (flipdesk-autolister reuses ai_reserved, so a crash-interrupted
// job is never double-charged, and the claim/heartbeat/reclaim contract is
// solid) — the damage is purely user-visible latency, and it is much worse than
// the ~30s outage SCALING.md documents:
//
//   JOB_STALE_MS   = 6 min   → a claimed job sits "running" this long
//   BATCH_STALE_MS = 15 min  → a batch sits stalled this long
//   reclaim crons    */5     → and only then does anything pick it back up
//
// So a seller whose batch was mid-generation during a deploy waits 6–15 minutes
// to see progress resume, with the UI showing "running" the whole time. Nothing
// is lost; it just looks broken.
//
// The fix has two halves, and BOTH are needed:
//   1. Stop CLAIMING new work the moment SIGTERM arrives. A job claimed two
//      seconds before exit is a job guaranteed to go stale — the claim is the
//      thing that starts the 6-minute clock, so not claiming is worth more than
//      draining fast.
//   2. Let already-running work finish, bounded by a deadline, then exit.
//
// Deliberately NOT a replacement for the reclaim sweeps. A SIGKILL, an OOM or a
// host failure still bypasses all of this, so the sweeps remain the correctness
// backstop; this is the latency optimisation for the ORDERLY case, which is
// every routine deploy.

import { logEvent } from "./observability.ts";

let shuttingDown = false;
let shutdownStartedMs = 0;
let inFlight = 0;

/** True once SIGTERM/SIGINT has been received. Never resets. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Number of tracked in-flight units of work. */
export function inFlightCount(): number {
  return inFlight;
}

/** Milliseconds since shutdown began, or 0 if not shutting down. */
export function shutdownElapsedMs(nowMs: number = Date.now()): number {
  return shuttingDown ? Math.max(0, nowMs - shutdownStartedMs) : 0;
}

/** Mark the process as draining. Idempotent — a second signal must not restart the clock. */
export function beginShutdown(nowMs: number = Date.now()): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownStartedMs = nowMs;
}

/**
 * Run `fn` while counting it as in-flight.
 *
 * The decrement is in a finally so a THROWN handler still releases its slot —
 * otherwise one failing request would keep the drain waiting for the full
 * deadline on every subsequent deploy, which is a slow leak that only shows up
 * as "shutdown always takes the maximum time".
 */
export async function trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

/**
 * Should a cron/job handler claim new work right now?
 *
 * Call this BEFORE acquiring a lock or claiming a lease. Returning false here
 * is what prevents the 6–15 minute stale window: an unclaimed job is picked up
 * by the next replica or the next tick immediately, whereas a job claimed just
 * before exit is stuck until its lease expires.
 */
export function canClaimNewWork(): boolean {
  return !shuttingDown;
}

/**
 * Wait for in-flight work to drain, up to `deadlineMs`.
 *
 * Returns true if it drained, false if the deadline was hit (callers should
 * exit anyway — a container that refuses to die gets SIGKILLed, which is
 * strictly worse than exiting with one straggler).
 *
 * `sleep` and `now` are injectable so the polling loop is testable without
 * real time.
 */
export async function awaitDrain(
  deadlineMs: number,
  deps: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    pollMs?: number;
  } = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 250;
  const started = now();

  while (inFlight > 0) {
    if (now() - started >= deadlineMs) return false;
    await sleep(pollMs);
  }
  return true;
}

/** Test-only reset. Module state is process-global by design. */
export function __resetLifecycleForTests(): void {
  shuttingDown = false;
  shutdownStartedMs = 0;
  inFlight = 0;
}

/**
 * Install SIGTERM/SIGINT handlers that drain then exit.
 *
 * Coolify/Docker send SIGTERM and then SIGKILL after a grace period (10s by
 * default), so the drain deadline must sit INSIDE that window or the drain is
 * pointless — we would be killed mid-drain having already stopped claiming
 * work. Default 8s, tunable via SHUTDOWN_DRAIN_MS.
 */
export function installShutdownHandlers(
  onDrained: () => void = () => Deno.exit(0),
): void {
  const drainMs = (() => {
    const raw = Number(Deno.env.get("SHUTDOWN_DRAIN_MS"));
    return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
  })();

  const handle = (signal: string) => async () => {
    if (isShuttingDown()) return; // a second signal must not double-drain
    beginShutdown();
    logEvent("info", "edge.shutdown_begin", { signal, in_flight: inFlightCount(), drain_ms: drainMs });
    const drained = await awaitDrain(drainMs);
    logEvent(drained ? "info" : "warn", "edge.shutdown_end", {
      signal,
      drained,
      in_flight: inFlightCount(),
      elapsed_ms: shutdownElapsedMs(),
    });
    onDrained();
  };

  // Windows Deno supports only SIGINT/SIGBREAK; registering SIGTERM there
  // throws. Dev boxes are Windows in this project, so guard rather than crash
  // the local server on startup.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(signal, handle(signal));
    } catch {
      // Unsupported on this platform — skip it; the other signal still applies.
    }
  }
}
