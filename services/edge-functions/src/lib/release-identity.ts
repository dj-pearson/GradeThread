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
