// Generic build-time seed registry for data-driven prerendered pages.
//
// US-1399 introduced this pattern for /transparency (see transparency-seed.ts):
// AI answer engines mostly do NOT run JS, so a page whose figures hydrate
// client-side renders "Not enough data yet" in the crawlable HTML. The fix is
// to fetch the same public endpoint at BUILD time and (1) seed the SSR render
// through a module the prerender sets, so the numbers land in the static HTML
// crawlers read, and (2) embed the seed as an inline JSON <script> the live SPA
// reads as the query's initialData, so humans see the same numbers at mount.
//
// transparency-seed.ts is the single-page original; this module generalizes it
// to a keyed registry so any number of data-report pages (resale-condition,
// state-of-durability, …) can seed their own payload without a bespoke module
// each. Keys are stable per page (e.g. "resale-condition-report").
//
// GRACEFUL DEGRADATION IS THE CONTRACT: when the build-time fetch fails (CI with
// no network, edge down, cold build), the seed stays null and the page renders
// exactly what it did before — placeholders that hydrate client-side. The
// prerender NEVER fails the build over one of these fetches.

const seeds: Record<string, unknown> = {};

/** Set by scripts/prerender.mjs before SSR-rendering a seeded route. */
export function setPrerenderSeed(key: string, value: unknown): void {
  seeds[key] = value;
}

/** The build-time seed for `key` (SSR) — null in the browser and unseeded builds. */
export function getPrerenderSeed<T = unknown>(key: string): T | null {
  return (seeds[key] as T | undefined) ?? null;
}

/** Reset (test helper). Clears one key, or the whole registry when omitted. */
export function clearPrerenderSeed(key?: string): void {
  if (key === undefined) {
    for (const k of Object.keys(seeds)) delete seeds[k];
  } else {
    delete seeds[key];
  }
}

/** Stable DOM id for a key's inline JSON <script>. */
export function seedDomId(key: string): string {
  return `prerender-seed-${key}`;
}

/**
 * JSON payload safe to inline inside a <script> tag: `<` is escaped so a value
 * containing "</script>" can't terminate the tag. The data is our own API's
 * aggregate output, but the escape costs nothing and removes the class.
 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Client-side read of the embedded seed (the inline JSON script the prerender
 * baked into the HTML). Returns null on any miss/parse failure.
 */
export function readSeedFromDom<T = unknown>(key: string): T | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(seedDomId(key));
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

/** SSR (module) then client (baked DOM) — the seed for `key`, or null. */
export function resolvePrerenderSeed<T = unknown>(key: string): T | null {
  return readSeedFromDom<T>(key) ?? getPrerenderSeed<T>(key);
}
