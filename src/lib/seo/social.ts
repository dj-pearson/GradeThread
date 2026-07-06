// Brand social-profile + entity configuration for Knowledge-Graph / AI-answer
// entity disambiguation (US-428).
//
// Search and answer engines resolve a brand by cross-referencing the profiles
// in Organization.sameAs and the twitter:site card. Listing a profile that
// 404s HURTS that signal, so every URL emitted here must be LIVE. Real handles
// are therefore supplied at build time via env vars and emitted ONLY when set —
// no placeholders (Google's structured-data policy + the US-428 acceptance
// criterion: "only live URLs"). Set the vars in .env once the profiles exist;
// no code change is needed to go live.
//
// One always-live profile is hard-coded: the public GitHub org. Everything else
// is opt-in via VITE_SOCIAL_* / VITE_TWITTER_*.

// The canonical, already-live GitHub profile for the org behind GradeThread.
const GITHUB_PROFILE = "https://github.com/dj-pearson/GradeThread";

// Build-time env read that works in EVERY runtime this module is evaluated in:
//   - the Vite SPA bundle and vitest      → import.meta.env (VITE_-prefixed)
//   - the prerender via vite.ssrLoadModule → import.meta.env
//   - the Node prerender script (process)  → process.env
// Returns "" when unset/blank so callers can filter falsy values out.
function envVar(key: string): string {
  let v: string | undefined;
  try {
    v = (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env?.[key];
  } catch {
    v = undefined;
  }
  if (!v) {
    const proc = (
      globalThis as { process?: { env?: Record<string, string | undefined> } }
    ).process;
    v = proc?.env?.[key];
  }
  return (v ?? "").trim();
}

/**
 * Live external profiles for `Organization.sameAs`. GitHub is always present;
 * X/LinkedIn/Instagram/Crunchbase (and any extra) are included only when their
 * env var holds a real URL. Order is stable so the prerendered head and the SPA
 * runtime JSON-LD stay byte-identical (jsonld-parity test).
 */
export function socialProfileUrls(): string[] {
  return [
    GITHUB_PROFILE,
    envVar("VITE_SOCIAL_X"),
    envVar("VITE_SOCIAL_LINKEDIN"),
    envVar("VITE_SOCIAL_INSTAGRAM"),
    envVar("VITE_SOCIAL_CRUNCHBASE"),
    // US-1677: YouTube channel (reseller grading shorts) — entity-confirming
    // sameAs. Config-gated like the rest; included only when set to a real URL.
    envVar("VITE_SOCIAL_YOUTUBE"),
    // US-1695: the Wikidata item for GradeThread — the strongest entity-anchoring
    // sameAs. Set VITE_SOCIAL_WIKIDATA (e.g. https://www.wikidata.org/wiki/Q…)
    // once the item is CLAIMED (only after 3–4 independent citations exist; see
    // docs/OFF_PAGE_AUTHORITY.md). Config-gated — never a placeholder.
    envVar("VITE_SOCIAL_WIKIDATA"),
  ].filter((u) => /^https?:\/\//.test(u));
}

/**
 * The brand X/Twitter @handle for `twitter:site` (e.g. "@gradethread"), or ""
 * when unconfigured. Normalized to a leading "@" so callers can emit it as-is.
 */
export function twitterSiteHandle(): string {
  const raw = envVar("VITE_TWITTER_SITE");
  if (!raw) return "";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

/**
 * The content-author/creator X handle for `twitter:creator` (e.g. an editorial
 * account). Falls back to the brand site handle when no distinct creator is set,
 * since for first-party pages the publisher IS the creator. "" when neither set.
 */
export function twitterCreatorHandle(): string {
  const raw = envVar("VITE_TWITTER_CREATOR");
  if (raw) return raw.startsWith("@") ? raw : `@${raw}`;
  return twitterSiteHandle();
}

/**
 * Optional public contact email for `Organization.contactPoint`. Emitted only
 * when VITE_CONTACT_EMAIL is a real, monitored address — asserting an unmanned
 * mailbox would be a false machine-readable claim.
 */
export function contactEmail(): string {
  const raw = envVar("VITE_CONTACT_EMAIL");
  return /@/.test(raw) ? raw : "";
}

/**
 * Optional ISO-8601 founding date for `Organization.foundingDate`. Emitted only
 * when VITE_FOUNDING_DATE holds a YYYY-MM-DD (or YYYY) value.
 */
export function foundingDate(): string {
  const raw = envVar("VITE_FOUNDING_DATE");
  return /^\d{4}(-\d{2}-\d{2})?$/.test(raw) ? raw : "";
}
