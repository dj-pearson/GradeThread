// Internal scheduled-job (cron) authentication (US-360).
//
// The /api/jobs/* endpoints (token refresh, repricing scan, publish-due,
// grading monitor, GSC sync, trial check, …) run unattended and are gated by a
// shared secret presented in a header — there is no user JWT. Two hardening
// requirements over the previous inline `provided !== expected` checks:
//
//   1. Constant-time comparison — a plain `!==` short-circuits on the first
//      differing byte, leaking secret bytes via response timing. We compare
//      SHA-256 digests of both sides so the comparison is fixed-time AND length
//      differences don't leak either.
//   2. Fail-closed — a missing env secret or a missing/empty presented value is
//      always a rejection, never an accidental allow.
//
// Dual-secret overlap rotation: set the new secret as the primary env var and
// (optionally) keep the previous one in FLIPDESK_INTERNAL_JOB_SECRET_OLD for the
// rollout window so in-flight schedulers configured with either value succeed;
// remove the OLD var once every caller is updated.

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
}

/** Fixed-time string equality via digest comparison (no length leak). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

/**
 * True when `provided` matches the expected job secret. Accepts an explicit
 * expected value (or an array of candidates, e.g. current + _OLD for overlap
 * rotation), else reads FLIPDESK_INTERNAL_JOB_SECRET (plus an optional
 * FLIPDESK_INTERNAL_JOB_SECRET_OLD for overlap rotation). Fail-closed.
 */
export async function verifyJobSecret(
  provided: string | null | undefined,
  expected?: string | null | Array<string | null | undefined>,
): Promise<boolean> {
  const got = (provided ?? "").trim();
  if (!got) return false;

  const candidates = Array.isArray(expected)
    ? expected
    : expected != null
    ? [expected]
    : [
      Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET"),
      Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET_OLD"),
    ];

  let ok = false;
  for (const cand of candidates) {
    const exp = (cand ?? "").trim();
    if (!exp) continue;
    // Evaluate all candidates (no early break) to keep timing independent of
    // which secret matched.
    if (await timingSafeEqual(got, exp)) ok = true;
  }
  return ok;
}

// ── Signed timestamped job requests (US-487) ───────────────────────
//
// Stronger alternative to presenting the static secret: the caller sends
//
//   X-Internal-Job-Timestamp: <unix epoch seconds>
//   X-Internal-Job-Signature: hex(HMAC-SHA256(secret, "v1:<ts>:<METHOD>:<path>"))
//
// The signature is bound to the method + path, only valid inside a small
// freshness window, and single-use within that window (process-local replay
// cache — the edge service deploys as a single container, so an in-memory
// cache covers the whole window). A captured request can't be replayed, and
// the secret itself never crosses the wire.

const SIGNED_JOB_VERSION = "v1";
const SIGNED_JOB_MAX_SKEW_SECONDS = 300;

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function signedJobMessage(
  timestampSeconds: number,
  method: string,
  path: string,
): string {
  return `${SIGNED_JOB_VERSION}:${timestampSeconds}:${method.toUpperCase()}:${path}`;
}

/** Compute the X-Internal-Job-Signature value a caller should send. */
export async function signJobRequest(
  secret: string,
  opts: { timestamp: number; method: string; path: string },
): Promise<string> {
  return await hmacSha256Hex(
    secret,
    signedJobMessage(opts.timestamp, opts.method, opts.path),
  );
}

// signature → expiry (epoch ms). Pruned on every verification.
const seenJobSignatures = new Map<string, number>();

export function clearJobReplayCacheForTests(): void {
  seenJobSignatures.clear();
}

type SignedHeaderReader = {
  req: {
    header: (name: string) => string | undefined;
    method: string;
    path: string;
  };
};

/**
 * Verifies a signed timestamped job request (headers above). Fail-closed:
 * missing/malformed headers, stale or future-dated timestamps, signatures for
 * a different method/path, and REPLAYED signatures are all rejections.
 */
export async function verifySignedJobRequest(
  c: SignedHeaderReader,
  secrets: Array<string | null | undefined>,
  opts: { maxSkewSeconds?: number; nowMs?: number } = {},
): Promise<boolean> {
  const sig = (c.req.header("X-Internal-Job-Signature") ?? "")
    .trim()
    .toLowerCase();
  const tsRaw = (c.req.header("X-Internal-Job-Timestamp") ?? "").trim();
  if (!sig || !tsRaw) return false;

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const nowMs = opts.nowMs ?? Date.now();
  const maxSkew = opts.maxSkewSeconds ?? SIGNED_JOB_MAX_SKEW_SECONDS;
  if (Math.abs(nowMs / 1000 - ts) > maxSkew) return false;

  const message = signedJobMessage(ts, c.req.method, c.req.path);
  let ok = false;
  for (const cand of secrets) {
    const secret = (cand ?? "").trim();
    if (!secret) continue;
    // Evaluate all candidates (no early break) — same timing rationale as
    // verifyJobSecret.
    if (await timingSafeEqual(sig, await hmacSha256Hex(secret, message))) {
      ok = true;
    }
  }
  if (!ok) return false;

  // Replay rejection: each signature is single-use. Entries outlive the skew
  // window (2x) so a signature can't be replayed at the window's edge.
  for (const [s, exp] of seenJobSignatures) {
    if (exp <= nowMs) seenJobSignatures.delete(s);
  }
  if (seenJobSignatures.has(sig)) return false;
  seenJobSignatures.set(sig, nowMs + maxSkew * 2 * 1000);
  return true;
}

type HeaderReader = { req: { header: (name: string) => string | undefined } };

/**
 * Convenience for Hono cron handlers: reads the job secret from the
 * X-Internal-Job-Secret header (or a Bearer Authorization header when
 * `bearer:true`) and verifies it constant-time. Returns true if authorized.
 */
export async function requireJobSecret(
  c: HeaderReader,
  opts: {
    bearer?: boolean;
    expected?: string | null | Array<string | null | undefined>;
  } = {},
): Promise<boolean> {
  let provided: string | undefined;
  if (opts.bearer) {
    const authz = c.req.header("Authorization") ?? "";
    provided = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  } else {
    provided = c.req.header("X-Internal-Job-Secret");
  }
  return await verifyJobSecret(provided, opts.expected);
}
