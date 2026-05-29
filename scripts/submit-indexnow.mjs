// Deploy-time IndexNow submitter for STATIC routes (US-297).
//
// Reads dist/seo-manifest.json (emitted from the route registry by the Vite
// seoManifestPlugin, US-291) and submits those absolute URLs to IndexNow, so a
// marketing/landing change is picked up by Bing/Yandex/Naver/Seznam right after
// the Cloudflare Pages deploy — without waiting for a crawl.
//
// Reuses the SAME endpoint + key contract as the edge runtime client
// (services/edge-functions/src/lib/indexnow.ts), but this one runs in Node/CI.
//
// Usage:
//   node scripts/submit-indexnow.mjs              # submit (needs INDEXNOW_KEY)
//   node scripts/submit-indexnow.mjs --dry-run    # print payload, no network
//   INDEXNOW_KEY=… node scripts/submit-indexnow.mjs --manifest dist/seo-manifest.json
//
// Designed to be non-blocking: main() always resolves and never throws, so a
// CI step using it can't fail the deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Parse argv into options. Pure (testable). */
export function parseArgs(argv) {
  const opts = { dryRun: false, manifestPath: "dist/seo-manifest.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--manifest" || a === "-m") opts.manifestPath = argv[++i];
  }
  return opts;
}

/**
 * Build the IndexNow POST payload from a parsed manifest + key. Pure (testable).
 * Returns null when there are no URLs to submit.
 */
export function buildPayload(manifest, key) {
  const siteUrl = String(manifest?.siteUrl ?? "https://gradethread.com").replace(
    /\/$/,
    "",
  );
  const host = new URL(siteUrl).host;
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const urlList = Array.from(
    new Set(
      routes
        .map((r) => r?.path)
        .filter((p) => typeof p === "string" && p.startsWith("/"))
        .map((p) => (p === "/" ? `${siteUrl}/` : `${siteUrl}${p}`)),
    ),
  );
  if (urlList.length === 0) return null;
  return { host, key, keyLocation: `${siteUrl}/${key}.txt`, urlList };
}

/**
 * Submit static routes to IndexNow. Never throws — returns a result object for
 * logging/tests. Skips cleanly (skipped:true) when the key is missing.
 */
export async function submitIndexNow({
  manifestPath = "dist/seo-manifest.json",
  key = process.env.INDEXNOW_KEY?.trim() || "",
  dryRun = false,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (!key && !dryRun) {
    log("[submit-indexnow] skipped: INDEXNOW_KEY not set");
    return { skipped: true, reason: "no-key" };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    log(`[submit-indexnow] skipped: cannot read ${manifestPath} (${e?.message ?? e})`);
    return { skipped: true, reason: "no-manifest" };
  }

  const payload = buildPayload(manifest, key || "DRY_RUN_KEY");
  if (!payload) {
    log("[submit-indexnow] skipped: manifest has no routes");
    return { skipped: true, reason: "no-routes" };
  }

  if (dryRun) {
    log(`[submit-indexnow] DRY RUN — would submit ${payload.urlList.length} url(s):`);
    for (const u of payload.urlList) log(`  ${u}`);
    return { skipped: false, dryRun: true, payload };
  }

  try {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    log(
      `[submit-indexnow] submitted ${payload.urlList.length} url(s) → ${res.status}`,
    );
    return { skipped: false, status: res.status, count: payload.urlList.length };
  } catch (e) {
    log(`[submit-indexnow] submit failed (non-fatal): ${e?.message ?? e}`);
    return { skipped: false, error: String(e?.message ?? e) };
  }
}

// CLI entry — only runs when invoked directly, not when imported by tests.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  await submitIndexNow(opts);
  // Always exit 0: this step must never fail a deploy.
  process.exit(0);
}
