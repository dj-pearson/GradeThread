// Which build is running? (US-513, US-2001)
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE BUG THIS MODULE EXISTS TO FIX, measured in production on 2026-08-09.
//
// `releaseSha()` used to read:
//
//     Deno.env.get("RELEASE_SHA") ?? Deno.env.get("COMMIT_SHA")
//       ?? Deno.env.get("SOURCE_COMMIT") ?? Deno.env.get("GIT_SHA") ?? "unknown"
//
// and its comment said "we accept any of the common env names so the same code
// works on Coolify / CI / local". It does not. The Dockerfile declares
// `ARG GIT_SHA=dev` and `ENV RELEASE_SHA=${GIT_SHA}`, so **RELEASE_SHA is ALWAYS
// SET in the image** — to the literal string "dev" when the builder passes no
// build arg. `??` only falls through on null/undefined, never on a placeholder
// VALUE. So the first key always won and every fallback below it was dead code
// on the one platform they were written for.
//
// The consequence is the part that cost three weeks: setting SOURCE_COMMIT as a
// normal Coolify environment variable — the obvious manual workaround, and the
// one COOLIFY.md was about to recommend — would have been SILENTLY IGNORED. The
// operator would have done the right thing and seen nothing change.
//
// How it stayed hidden: production reported release "dev", which is exactly what
// a missing build arg looks like, so every previous pass went hunting for the
// build arg (three compose files now declare it). The build arg may well still
// be missing. But it was never the only fault, and fixing it alone would not
// have been enough while a runtime override could not take effect.
//
// THE RULE NOW: fall through on a placeholder VALUE, not merely on an unset key.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Env keys that can carry the build's identity, in precedence order.
 *
 * RELEASE_SHA is first because a deliberate build-arg stamp should win. The rest
 * are what the surrounding platforms set on their own: Coolify populates
 * SOURCE_COMMIT, most CI images export COMMIT_SHA or GIT_SHA.
 */
export const RELEASE_ENV_KEYS = [
  "RELEASE_SHA",
  "COMMIT_SHA",
  "SOURCE_COMMIT",
  "GIT_SHA",
] as const;

/**
 * Values that name no build.
 *
 * Deliberately permissive on FORM — any non-placeholder string counts. The
 * failure actually observed in production was the literal ARG default surviving
 * the build, not a malformed SHA, and demanding 40 hex characters would break
 * short-SHA and tag-based deploys for no benefit.
 */
const RELEASE_PLACEHOLDERS = new Set([
  "",
  "dev",
  "unknown",
  "local",
  "none",
  "latest",
]);

/** The value names no build (unset, blank, or a placeholder like "dev"). */
export function isPlaceholderRelease(value: string | undefined | null): boolean {
  return RELEASE_PLACEHOLDERS.has((value ?? "").trim().toLowerCase());
}

/**
 * The first env key holding a real build identity, or "unknown".
 *
 * Pure and injectable so the production failure can be reproduced as a test
 * case rather than described in a comment: `resolveRelease(k => k === "RELEASE_SHA"
 * ? "dev" : k === "SOURCE_COMMIT" ? "abc123" : undefined)` is the exact prod
 * environment, and it must return "abc123".
 */
export function resolveRelease(
  get: (k: string) => string | undefined,
): string {
  for (const key of RELEASE_ENV_KEYS) {
    const raw = (get(key) ?? "").trim();
    if (!isPlaceholderRelease(raw)) return raw.slice(0, 40);
  }
  return "unknown";
}

// ── US-2001: which variable SHOULD we be reading? ───────────────────────────
//
// resolveRelease answers "which build is this" and, when the answer is
// "unknown", says nothing about WHY. That gap has cost this story weeks: the
// operator sees release "unknown", has no way to tell an unset variable from
// one set under a name this code does not read, and is left guessing at how
// Coolify exposes the commit. Three passes went hunting for a build arg.
//
// This closes the loop from the other end. If SOME variable on the running
// container already holds what looks like a build identity, name it — then the
// fix is "add that key" or "copy that value into SOURCE_COMMIT" rather than a
// fourth round of guesswork.
//
// NAMES ONLY, NEVER VALUES, and that is not a nicety. Anything printed here
// lands in a deploy log, so a value would put whatever the key holds somewhere
// it was never meant to be. The names alone are enough to act on.

/** Key names worth reporting: they claim to carry a commit. */
const CANDIDATE_NAME_RE = /(COMMIT|REVISION|_SHA|SHA_|^SHA$|GIT_REF|^REF$)/i;

/**
 * Names that must never be printed even when they match above.
 *
 * A key called `COMMIT_SIGNING_KEY` matches CANDIDATE_NAME_RE and is a secret.
 * The deny list wins on purpose: a missed diagnostic costs one more question,
 * a leaked secret name in a deploy log costs a rotation.
 */
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY$|^KEY$|APIKEY|API_KEY)/i;

/** How many to report. A long list is a list nobody reads. */
const MAX_CANDIDATES = 8;

/**
 * Env key NAMES that look like they carry this build's identity but are not in
 * RELEASE_ENV_KEYS — so nothing is reading them.
 *
 * Returns [] when the release already resolves, because the diagnostic is only
 * interesting while the answer is "unknown". Pure and injectable so the whole
 * thing is testable without touching a real environment.
 */
export function unreadReleaseCandidates(
  entries: Iterable<[string, string]>,
): string[] {
  const known = new Set<string>(RELEASE_ENV_KEYS);
  const out: string[] = [];
  for (const [key, value] of entries) {
    if (known.has(key)) continue;
    if (SECRET_NAME_RE.test(key)) continue;
    if (!CANDIDATE_NAME_RE.test(key)) continue;
    // A key holding "dev" is not a candidate — pointing the operator at it
    // would send them to the same placeholder they already have.
    if (isPlaceholderRelease(value)) continue;
    out.push(key);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
