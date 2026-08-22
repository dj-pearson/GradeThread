// US-1669: prerender / hydration parity CI audit.
//
// Prerendered SPAs commonly DRIFT: hydration overwrites the <title>/canonical,
// content that a snippet or a JS-less LLM crawler depends on is injected only
// after hydration (so bots never see it), or a client-side redirect fires. This
// audit asserts that what a bot fetches (the static dist/*.html — the same bytes
// Cloudflare serves before any JS runs) already contains the FULL content:
//   - exactly one <title> and one rel=canonical (no hydration duplicate/overwrite)
//   - the #root is populated with real content, not an empty SPA shell
//   - route-specific body content (esp. the grade TABLE) is in the initial HTML
//     byte-stream, not hydrated in
//   - no <meta http-equiv=refresh> client-side redirect
//
// It runs against the built dist/ (skipped when absent so the unit suite stays
// build-independent); CI runs `npm run build` before the test job, so a drift
// fails the build.
//
// There is no docs/PRERENDER_PARITY.md — this header used to point at one that
// was never written. The four bullets above ARE the checklist: each maps to one
// case below, and the fix for a red one is to make the STATIC html satisfy it,
// never to relax the assertion.

import { describe, it, expect } from "vitest";
import { requireDist } from "../../test/dist-required";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = (p: string) => resolve(process.cwd(), "dist", p);
const fileFor = (routePath: string) =>
  routePath === "/"
    ? dist("index.html")
    : dist(`${routePath.replace(/^\//, "")}.html`);

// ≥10 representative URLs across the surface types the plan calls out
// (marketing pillar, the keystone scale page + its table, a glossary spoke, a
// cornerstone article, the data report, legal). Each `must` string has to appear
// in the RAW prerendered HTML — proving the content is in the byte-stream.
const AUDIT: Array<{ path: string; must: string[] }> = [
  // Canary for the landing hero. Deliberately a phrase with no apostrophe or
  // em-dash: those render as HTML entities in the byte-stream, so a canary
  // containing them fails for encoding reasons rather than real hydration
  // drift. Update this whenever the hero H1/subhead copy changes.
  { path: "/", must: ["Photograph it.", "ready-to-publish eBay"] },
  {
    // The keystone — its grade TABLE is the single most-lifted structure in LLM
    // answers, so it MUST be static, not hydrated.
    path: "/grading/scale",
    must: [
      "<table",
      "Marketplace equivalent",
      "The GradeThread Scale is a standardized",
      "New Without Tags",
    ],
  },
  { path: "/condition-grading", must: ["Fabric Condition", "1.0"] },
  { path: "/grading-standard", must: ["weighted factor"] },
  { path: "/transparency", must: ["agreement"] },
  { path: "/resale-condition-report", must: ["return rate", "grade band"] },
  { path: "/reduce-returns", must: ["not as described"] },
  { path: "/reseller-grading-guide", must: ["<h1"] },
  { path: "/pricing", must: ["<h1"] },
  { path: "/faq", must: ["<h1"] },
  { path: "/grading/nwt", must: ["New With Tags"] },
  { path: "/about", must: ["Pearson Media"] },
];

const hasDist = requireDist(dist("index.html"), "crawl-parity.test.ts");

describe.skipIf(!hasDist)("prerender/hydration parity audit (US-1669)", () => {
  it.each(AUDIT.map((a) => [a.path, a] as const))(
    "%s: single title+canonical, populated #root, full content in the byte-stream",
    (_path, entry) => {
      const file = fileFor(entry.path);
      expect(existsSync(file), `${file} should exist — is it prerendered?`).toBe(
        true,
      );
      const html = readFileSync(file, "utf8");

      // Exactly one title + canonical — no hydration duplicate or overwrite.
      expect(
        (html.match(/<title[\s>]/gi) ?? []).length,
        `${entry.path}: expected exactly 1 <title>`,
      ).toBe(1);
      expect(
        (html.match(/<link[^>]+rel=["']?canonical["']?/gi) ?? []).length,
        `${entry.path}: expected exactly 1 rel=canonical`,
      ).toBe(1);

      // No client-side redirect a crawler would trip over.
      expect(
        /<meta[^>]+http-equiv=["']?refresh["']?/i.test(html),
        `${entry.path}: a <meta http-equiv=refresh> would redirect crawlers`,
      ).toBe(false);

      // #root is populated with REAL content (an element, not the empty shell).
      expect(
        /<div id="root"><[a-z]/i.test(html),
        `${entry.path}: #root is an empty SPA shell — content is hydrated in, not prerendered`,
      ).toBe(true);

      // Route-specific content present in the raw HTML (byte-stream, pre-JS).
      for (const needle of entry.must) {
        expect(
          html.includes(needle),
          `${entry.path}: "${needle}" missing from the prerendered HTML (hydration drift?)`,
        ).toBe(true);
      }
    },
  );

  it("audits at least 10 representative URLs", () => {
    expect(AUDIT.length).toBeGreaterThanOrEqual(10);
  });
});
