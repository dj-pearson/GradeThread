// US-1399: build-time seed for the /transparency live figures.
//
// AI answer engines mostly do NOT run JS, and the transparency page's numeric
// facts (accuracy, agreement, review rate, per-category MAE…) used to hydrate
// client-side only — so the crawlable HTML said "Not enough data yet"
// everywhere. The prerender step now fetches the same public endpoint the SPA
// uses (/api/grading/public/transparency) at BUILD time and:
//
//   1. seeds the SSR render through this module, so the numbers land in the
//      static HTML crawlers read, and
//   2. the page embeds the seed as an inline JSON <script>, which the live SPA
//      reads as the query's initialData — humans see the same numbers
//      immediately at hydration (then TanStack Query revalidates as usual).
//
// GRACEFUL DEGRADATION IS THE CONTRACT: when the build-time fetch fails (CI
// with no network, edge down, cold build), the seed stays null and the page
// renders exactly what it did before — placeholders that hydrate client-side.
// The prerender NEVER fails the build over this fetch (the reason US-1399 was
// originally deferred).

export interface TransparencySeedReport {
  // Matches the shape served by /api/grading/public/transparency; the page
  // owns the full type — this module treats it opaquely.
  [key: string]: unknown;
}

export const TRANSPARENCY_SEED_DOM_ID = "transparency-seed";

let seed: TransparencySeedReport | null = null;

/** Set by scripts/prerender.mjs before SSR-rendering /transparency. */
export function setTransparencySeed(report: TransparencySeedReport | null): void {
  seed = report;
}

/** The build-time seed (SSR) — null in the browser and in unseeded builds. */
export function getTransparencySeed(): TransparencySeedReport | null {
  return seed;
}

/**
 * JSON payload safe to inline inside a <script> tag: `<` is escaped so a
 * value containing "</script>" can't terminate the tag. The data is our own
 * API's aggregate output, but the escape costs nothing and removes the class.
 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Client-side read of the embedded seed (the inline JSON script the prerender
 * baked into the HTML). Returns null on any miss/parse failure.
 */
export function readSeedFromDom(): TransparencySeedReport | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(TRANSPARENCY_SEED_DOM_ID);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as TransparencySeedReport;
  } catch {
    return null;
  }
}
