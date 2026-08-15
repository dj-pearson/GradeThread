import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// US-2583: the wall around members-only and internal help articles.
//
// The wall itself is three things, and this file checks all three because each
// one fails silently on its own:
//   1. RLS in migration 00602 — the SSR worker reads with the ANON key, so the
//      anon policy is what keeps non-public rows off the public web.
//   2. visibilitiesFor(viewer) in the edge lib — the service-role client
//      bypasses RLS, so in that process the filter IS the wall.
//   3. Every PUBLIC surface calling only the anonymous endpoint, which cannot
//      return a members or internal row in the first place.
//
// A gated article leaking is not a 500 anybody sees. It is an operator runbook
// quietly appearing in a sitemap.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Drop comments before scanning for endpoints.
 *
 * Every file here explains its own wall in prose, and that prose names the very
 * strings the scan is looking for. Without this the guard fails on its own
 * documentation, which is the fastest way to get a guard deleted.
 *
 * ⚠ LINE comments first, THEN block comments, and the order is load-bearing.
 * The help Function's header comment contains a literal slash-star sequence in
 * the path `/help` plus a wildcard, which the block-comment pattern reads as an
 * opening delimiter. Running it first ate everything down to the next block
 * terminator a hundred lines later, so this guard was silently scanning a
 * truncated file and could not have seen a bad call in the part it swallowed
 * (found in US-2592).
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every file that produces something a crawler or an answer engine consumes. */
const PUBLIC_SURFACES = [
  "functions/help/[[path]].ts",
  "functions/help.md.ts",
  "functions/sitemap-help.xml.ts",
  "functions/_shared/sitemap.ts",
  "functions/llms.txt.ts",
  "functions/og/help/[slug].ts",
];

describe("no public surface can reach a non-public article", () => {
  it.each(PUBLIC_SURFACES)("%s calls only the anonymous help endpoint", (file) => {
    const src = stripComments(read(file));
    // Every /api/... path in a string literal, normalised from the /api/ mark so
    // a `${base}/api/...` template literal is compared on the same footing.
    const helpCalls = [...src.matchAll(/["'`][^"'`]*?(\/api\/[^"'`]*)["'`]/g)]
      .map((m) => m[1]!)
      .filter((p) => p.includes("help"));
    for (const path of helpCalls) {
      expect(
        path.startsWith("/api/content/public/help"),
        `${file} reaches ${path}, which can return non-public rows`,
      ).toBe(true);
    }
  });

  it.each(PUBLIC_SURFACES)("%s never mentions the authed help mounts", (file) => {
    const src = stripComments(read(file));
    expect(src).not.toMatch(/["'`][^"'`]*\/api\/help[/"'`?]/);
    expect(src).not.toMatch(/["'`][^"'`]*\/api\/content\/help[/"'`?]/);
  });
});

describe("the database refuses too, not just the code", () => {
  const sql = read("supabase/migrations/00602_help_center_articles.sql");

  it("the anon policy matches published PUBLIC rows and nothing else", () => {
    const policy = sql.slice(
      sql.indexOf('create policy "anon read published public help"'),
      sql.indexOf('drop policy if exists "authenticated read published help"'),
    );
    expect(policy).toContain("to anon");
    expect(policy).toContain("status = 'published'");
    expect(policy).toContain("visibility = 'public'");
  });

  it("the authenticated policy stops short of 'internal'", () => {
    // An authenticated session belongs to a CUSTOMER. Operator runbooks are not
    // customer-readable just because somebody signed up.
    const policy = sql.slice(sql.indexOf('create policy "authenticated read published help"'));
    expect(policy).toContain("visibility in ('public', 'members')");
    expect(policy).not.toMatch(/visibility in \([^)]*internal/);
  });
});

describe("the reader is not indexable", () => {
  const src = read("src/pages/help-reader.tsx");

  it("every page it renders is noindex", () => {
    const seoTags = [...src.matchAll(/<SEO\b[^>]*>/g)].map((m) => m[0]);
    expect(seoTags.length).toBeGreaterThan(0);
    for (const tag of seoTags) expect(tag).toContain("noindex");
  });

  it("/dashboard is disallowed to crawlers", () => {
    const routes = JSON.parse(read("public/_routes.json")) as { include: string[] };
    // It is Function-routed (so the SPA shell is served with app headers), and
    // the app-shell headers are where the noindex lives.
    expect(routes.include).toContain("/dashboard/*");
  });

  it("is NOT in PUBLIC_ROUTES, so it is never prerendered or sitemapped", () => {
    const src2 = read("src/lib/seo/public-routes.ts");
    expect(src2).not.toContain('"/dashboard/help"');
  });
});

describe("the reader labels what it shows", () => {
  const src = read("src/pages/help-reader.tsx");

  it("marks members-only and internal articles", () => {
    expect(src).toContain("HELP_VISIBILITY_LABELS");
    expect(src).toContain("VisibilityBadge");
  });

  it("does not badge public articles", () => {
    // They are the default. Badging every row would make the two that matter
    // disappear into the noise.
    expect(src).toContain('if (visibility === "public") return null');
  });

  it("never asks the server for a visibility — the server decides", () => {
    // The page renders `visibility={...}` as a JSX prop to LABEL a row; what it
    // must never do is send one, or re-derive the rule the edge owns.
    expect(src).not.toMatch(/[?&]visibility=/);
    // Nor re-derive the rule the edge lib owns. Reading `a.visibility` off a row
    // to badge it is fine; deciding from it what to fetch is not.
    expect(src).not.toContain("visibilitiesFor");
    expect(src).not.toMatch(/["']internal["']\s*[),]/);
  });
});

describe("the gating rule is written down", () => {
  it("a vault note explains what is gated and why", () => {
    const note = read("vault/40-growth/help-center-gating.md");
    expect(note).toContain("public");
    expect(note).toContain("members");
    expect(note).toContain("internal");
  });

  it("the vault index links it", () => {
    const moc = read("vault/00-index/moc-growth.md");
    expect(moc).toContain("help-center-gating");
  });
});
