// US-2612: prove the Cloudflare Pages half of the origin secret from the EDGE,
// by observing it, instead of reading our own environment and calling that an
// answer.
//
// THE PROBLEM WITH THE OLD LINE. features.pages_origin_bypass on /health/ready
// reported whether CF_PAGES_ORIGIN_SECRET is set HERE, and said outright that it
// could not see the Cloudflare Pages project. That was honest and it was also
// permanently unactionable: a Pages-side value that is missing, or set to
// something different, behaves exactly like no secret at all, and the edge's own
// env can never distinguish the three. So the line was destined to read "one of
// the two halves" forever while the interesting question stayed open.
//
// THE EVIDENCE THAT DOES SETTLE IT. A request arriving with a matching
// `x-pages-origin` header can only have been sent by something holding the same
// secret, and the only thing that holds it is the Pages project. One matched
// request is direct proof that both halves agree — which no amount of reading
// our own configuration can produce.
//
// PROCESS-LOCAL AND DELIBERATELY NOT PERSISTED. The counter resets on every
// container restart, and that is the correct scope rather than a limitation:
// what an operator needs to know after a deploy is whether the CURRENT process
// is being reached, and a value carried over from before the restart would
// answer a question nobody asked. The readiness line states its own window for
// exactly this reason.

/** What the process has observed. Passed to the pure formatter below. */
export interface PagesOriginObservation {
  /** ms timestamp of the most recent matching request, or null if none. */
  lastMatchMs: number | null;
  /** How many matched since this process started. */
  matchCount: number;
  /** When this process started observing. */
  bootMs: number;
}

/**
 * How long after boot a silence starts meaning something. Before this, zero
 * matches is the expected state of a freshly deployed container and reporting it
 * as a gap would fire on every single deploy — the fastest way to teach an
 * operator to skim past this line.
 */
export const QUIET_GRACE_MS = 15 * 60_000;

let lastMatchMs: number | null = null;
let matchCount = 0;
let bootMs = Date.now();

/**
 * Record that a request carried a matching x-pages-origin. Called from BOTH
 * matchers in middleware/rate-limit.ts — the rate-limit bypass and the auth
 * gate — because either one matching is the same proof about the same secret.
 *
 * Two assignments on a hot path, no allocation, no I/O.
 */
export function recordPagesOriginMatch(nowMs: number = Date.now()): void {
  lastMatchMs = nowMs;
  matchCount++;
}

/** The current observation. */
export function pagesOriginObservation(): PagesOriginObservation {
  return { lastMatchMs, matchCount, bootMs };
}

/** Tests only: forget everything and restart the clock. */
export function resetPagesOriginObservation(nowMs: number = Date.now()): void {
  lastMatchMs = null;
  matchCount = 0;
  bootMs = nowMs;
}

function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

/**
 * The readiness sentence, or null when the process has nothing worth saying yet.
 *
 * PURE — observation and clock in, string out — so both branches and the grace
 * boundary are testable without a running server or a real request.
 *
 * A null return means "keep the existing two-sided caveat": we are inside the
 * grace window and silence carries no information.
 */
export function pagesOriginEvidenceLine(
  obs: PagesOriginObservation,
  nowMs: number,
): string | null {
  if (obs.lastMatchMs !== null) {
    const ago = humanMs(Math.max(0, nowMs - obs.lastMatchMs));
    return (
      `PROVEN FROM THE OTHER SIDE: ${obs.matchCount} request(s) carrying a ` +
      `matching x-pages-origin have reached this service since it started, the ` +
      `most recent ${ago} ago. Only something holding the same secret can send ` +
      `that header, and the only thing that holds it is the Cloudflare Pages ` +
      `project — so both halves agree. This supersedes the "cannot tell" caveat ` +
      `this line used to carry (US-781/US-2612).`
    );
  }

  const up = Math.max(0, nowMs - obs.bootMs);
  if (up < QUIET_GRACE_MS) return null;

  return (
    `set here, and NOT YET PROVEN from the other side: no request carrying a ` +
    `matching x-pages-origin has arrived in the ${humanMs(up)} since this ` +
    `process started. That is either genuine quiet — no public page has been ` +
    `server-rendered in that window — or the Cloudflare Pages project is ` +
    `missing the value or holds a different one, which behaves exactly like no ` +
    `secret at all. To tell them apart, fetch any blog post or certificate page ` +
    `and re-read this line (US-781/US-2612).`
  );
}
