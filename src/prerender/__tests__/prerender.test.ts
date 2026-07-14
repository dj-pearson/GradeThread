import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { isGlossaryPath } from "@/lib/seo/glossary";
import {
  buildHeadTags,
  jsonLdForRoute,
  stripHeadTagsFromBody,
} from "../head-builder";

const dist = (p: string) => resolve(process.cwd(), "dist", p);
const landing = PUBLIC_ROUTES.find((r) => r.path === "/")!;
const privacy = PUBLIC_ROUTES.find((r) => r.path === "/privacy")!;
const conditionGrading = PUBLIC_ROUTES.find(
  (r) => r.path === "/condition-grading",
)!;
// A per-term glossary SPOKE (e.g. /grading/nwt) — NOT the /grading/scale pillar
// (US-1664), which lives under /grading/ too but emits a DefinedTermSet.
const glossarySpoke = PUBLIC_ROUTES.find((r) => isGlossaryPath(r.path))!;

describe("prerender head-builder (US-292)", () => {
  it("landing head has exactly one title, canonical, robots index, and 4 JSON-LD blocks", () => {
    const head = buildHeadTags(landing);
    expect((head.match(/<title>/g) ?? []).length).toBe(1);
    expect(head).toContain(
      '<link rel="canonical" href="https://gradethread.com/">',
    );
    expect(head).toContain(
      'content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"',
    );
    expect((head.match(/application\/ld\+json/g) ?? []).length).toBe(4);
  });

  it("landing JSON-LD includes Organization, WebSite, SoftwareApplication, FAQPage", () => {
    const types = jsonLdForRoute("/").map((o) => o["@type"]);
    expect(types).toEqual([
      "Organization",
      "WebSite",
      "SoftwareApplication",
      "FAQPage",
    ]);
  });

  it("legal route head carries a self-canonical + Organization/Breadcrumb JSON-LD", () => {
    const head = buildHeadTags(privacy);
    expect(head).toContain('href="https://gradethread.com/privacy"');
    const types = jsonLdForRoute("/privacy").map((o) => o["@type"]);
    expect(types).toEqual(["Organization", "BreadcrumbList"]);
  });

  it("a glossary spoke's head contains a DefinedTerm script linked to the set (US-973)", () => {
    const head = buildHeadTags(glossarySpoke);
    expect(head).toContain('"@type":"DefinedTerm"');
    expect(head).toContain(
      '"inDefinedTermSet":"https://gradethread.com/#condition-glossary"',
    );
    const types = jsonLdForRoute(glossarySpoke.path).map((o) => o["@type"]);
    expect(types).toContain("DefinedTerm");
  });

  it("the condition-grading hub head emits the DefinedTermSet (US-973)", () => {
    const head = buildHeadTags(conditionGrading);
    expect(head).toContain('"@type":"DefinedTermSet"');
    expect(head).toContain('"@id":"https://gradethread.com/#condition-glossary"');
    const types = jsonLdForRoute("/condition-grading").map((o) => o["@type"]);
    expect(types).toContain("DefinedTermSet");
  });

  it("JSON-LD escapes < so it cannot break out of the script tag", () => {
    const head = buildHeadTags(landing);
    expect(head).not.toMatch(/<\/script>\s*<\/script>/);
    // the escaped form appears for any literal < inside JSON values
    expect(head.includes("\\u003c") || !head.includes("<script><")).toBe(true);
  });

  it("stripHeadTagsFromBody removes inline SEO tags but keeps real markup", () => {
    const body =
      '<title>x</title><meta name="description" content="d">' +
      '<link rel="canonical" href="https://x/"><h1>Hello</h1>' +
      '<meta property="og:title" content="t"><p>Body</p>';
    const out = stripHeadTagsFromBody(body);
    expect(out).not.toContain("<title>");
    expect(out).not.toContain('name="description"');
    expect(out).not.toContain('rel="canonical"');
    expect(out).not.toContain("og:title");
    expect(out).toContain("<h1>Hello</h1>");
    expect(out).toContain("<p>Body</p>");
  });
});

// US-1950: the client route-chunk preload map must cover every prerendered path
// (and nothing more), or a route ships without its chunk preloaded and flashes
// the full-screen suspense spinner. entry-server also enforces this at import via
// a throwing guard; this test gives a fast, readable CI signal on drift.
describe("route→chunk preload map (US-1950)", () => {
  it("ROUTE_PAGE_MODULES has exactly one entry per prerenderable path", async () => {
    const { PRERENDERABLE_PATHS, ROUTE_PAGE_MODULES } = await import(
      "../entry-server"
    );
    const paths = [...PRERENDERABLE_PATHS].sort();
    const mapped = Object.keys(ROUTE_PAGE_MODULES).sort();
    expect(mapped).toEqual(paths);
    // Every module id points under src/pages/ (matched by suffix in prerender.mjs).
    for (const id of Object.values(ROUTE_PAGE_MODULES)) {
      expect(id).toMatch(/^src\/pages\//);
    }
  });
});

// These run only after a build has produced dist/. Skipped otherwise so the
// unit suite stays build-independent; CI runs them after `npm run build`.
const hasDist = existsSync(dist("index.html"));
describe.skipIf(!hasDist)("prerendered dist output (US-292)", () => {
  it("dist/index.html contains the landing hero as static text (no JS needed)", () => {
    const html = readFileSync(dist("index.html"), "utf8");
    expect(html).toContain("The Trusted Standard for Clothing");
    expect((html.match(/<title>/g) ?? []).length).toBe(1);
    expect(html).toContain("application/ld+json");
    // body actually populated (not the empty SPA shell)
    expect(html).toMatch(/<div id="root"><[a-z]/);
  });

  it("inner marketing routes preload their own route chunk (US-1950)", () => {
    // The client render (createRoot, not hydrate) suspends on the lazy route
    // until its chunk downloads; prerender injects a <link rel=modulepreload> for
    // that chunk so it's already in flight. Assert the page's own chunk is
    // preloaded (a route named like the page module → e.g. how-it-works-*.js).
    for (const [routePath, chunkStem] of [
      ["/how-it-works", "how-it-works"],
      ["/for-resellers", "for-resellers"],
      ["/whats-it-worth", "whats-it-worth"],
    ] as const) {
      const html = readFileSync(dist(`${routePath.replace(/^\//, "")}.html`), "utf8");
      const re = new RegExp(
        `<link rel="modulepreload"[^>]*href="/assets/${chunkStem}-[^"]+\\.js"`,
      );
      expect(re.test(html), `${routePath} should modulepreload its ${chunkStem} chunk`).toBe(
        true,
      );
    }
  });

  it("each registered route emitted a static HTML file with one title", () => {
    for (const r of PUBLIC_ROUTES) {
      // prerender.mjs writes FLAT files (dist/<route>.html), NOT directory
      // indexes — a deliberate choice so Cloudflare Pages serves /privacy with a
      // clean 200 instead of 308-redirecting to /privacy/ (see prerender.mjs).
      const file =
        r.path === "/"
          ? dist("index.html")
          : dist(`${r.path.replace(/^\//, "")}.html`);
      expect(existsSync(file), `${file} should exist`).toBe(true);
      const html = readFileSync(file, "utf8");
      expect((html.match(/<title>/g) ?? []).length).toBe(1);
    }
  });
});
