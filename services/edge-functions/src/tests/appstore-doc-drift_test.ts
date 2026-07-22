// US-2123 follow-up: APP_STORE_SUBMISSION.md publishes the plan entitlements to
// App Review by hand, and — like the iOS paywall blurb that advertised "1,000 AI
// actions" while the server granted 750 — nothing guarded it against the server
// catalog. It happened to be right; this makes that a guarantee.
//
// The canonical numbers live in CATALOG blurbs (lib/appstore/products.ts). If a
// tier's entitlement changes there and the submission doc isn't updated, App
// Review (and any reviewer reading the doc) is told a number the server no
// longer grants. This asserts every numeric entitlement phrase from each
// subscription blurb appears in the doc, so that drift fails the build.

import { assert } from "@std/assert";
import { CATALOG } from "../lib/appstore/products.ts";

const DOC_PATH = new URL(
  "../../../../ios/APP_STORE_SUBMISSION.md",
  import.meta.url,
);

Deno.test("US-2123: APP_STORE_SUBMISSION.md entitlements match the server catalog", async () => {
  const doc = await Deno.readTextFile(DOC_PATH);

  // Collect the distinct "<number> <unit>" entitlement phrases the SERVER
  // advertises for subscription tiers (Business is "Unlimited …" with no
  // numbers, so it contributes none — the regex simply doesn't match it).
  const phrases = new Set<string>();
  for (const entry of CATALOG) {
    if (entry.mapping.kind !== "subscription") continue;
    for (const m of entry.blurb.matchAll(/([\d,]+) (listings|AI actions|grades)/g)) {
      phrases.add(`${m[1]} ${m[2]}`);
    }
  }

  assert(phrases.size > 0, "no subscription entitlement phrases parsed from CATALOG");

  const missing = [...phrases].filter((p) => !doc.includes(p));
  assert(
    missing.length === 0,
    `APP_STORE_SUBMISSION.md is missing server entitlement phrase(s) — the ` +
      `published copy has drifted from lib/appstore/products.ts: ${missing.join("; ")}`,
  );
});
