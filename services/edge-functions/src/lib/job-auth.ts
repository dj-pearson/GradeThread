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
 * expected value, else reads FLIPDESK_INTERNAL_JOB_SECRET (plus an optional
 * FLIPDESK_INTERNAL_JOB_SECRET_OLD for overlap rotation). Fail-closed.
 */
export async function verifyJobSecret(
  provided: string | null | undefined,
  expected?: string | null,
): Promise<boolean> {
  const got = (provided ?? "").trim();
  if (!got) return false;

  const candidates = expected != null
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

type HeaderReader = { req: { header: (name: string) => string | undefined } };

/**
 * Convenience for Hono cron handlers: reads the job secret from the
 * X-Internal-Job-Secret header (or a Bearer Authorization header when
 * `bearer:true`) and verifies it constant-time. Returns true if authorized.
 */
export async function requireJobSecret(
  c: HeaderReader,
  opts: { bearer?: boolean; expected?: string | null } = {},
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
