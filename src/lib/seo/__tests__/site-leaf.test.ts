// The SEO scalar leaf must stay a leaf.
//
// src/lib/seo/site.ts was split out of public-routes.ts for one reason: any
// module that imports the registry inherits the 17 route-data modules behind
// PUBLIC_ROUTES, which Rollup hoists into a single shared chunk carrying the
// marketing prose for all 213 public routes. Before the split that chunk was in
// the EAGER graph of every page — 305 KB raw / 89 KB gzipped of copy the landing
// page never renders, already duplicated in each route's prerendered HTML.
// Splitting the scalars out cut the eager graph from 305 KB to 241 KB gzipped.
//
// Nothing about that win is self-defending. Adding `import { PUBLIC_ROUTES }`
// to site.ts, or pointing seo.tsx back at public-routes, silently restores the
// full weight — the build still succeeds, every test still passes, and the only
// symptom is a slower first paint that no one attributes to the import.
//
// So these assertions guard the two edges that carry the property.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("SEO scalar leaf stays leaf-shaped", () => {
  it("site.ts imports nothing at all", () => {
    const text = read("src/lib/seo/site.ts");
    const imports = text.match(/^\s*import\s.+$/gm) ?? [];
    expect(
      imports,
      "src/lib/seo/site.ts must have NO imports. It is the module every page " +
        "pulls for SITE_URL; an import here can drag the 213-route registry (and " +
        "its prose) back into the eager bundle of every page.\nFound:\n  " +
        imports.join("\n  "),
    ).toEqual([]);
  });

  it("the modules every page loads do not import the route registry", () => {
    // seo.tsx renders on essentially every route and json-ld.ts is pulled with
    // it, so these two decide whether the registry is eager or lazy.
    const hot = ["src/components/seo.tsx", "src/lib/seo/json-ld.ts"];
    for (const rel of hot) {
      expect(
        read(rel),
        `${rel} is in the eager graph of every page. Importing from ` +
          '"@/lib/seo/public-routes" here pulls PUBLIC_ROUTES and all 17 ' +
          "route-data modules into the initial download. Import the scalars " +
          'from "@/lib/seo/site" instead.',
      ).not.toMatch(/from\s+"(@\/lib\/seo\/|\.\/)public-routes"/);
    }
  });

  it("site.ts still exports every scalar public-routes re-exports", () => {
    // public-routes.ts re-exports these for its 66 existing consumers. If a
    // symbol is dropped from site.ts the re-export becomes a broken binding,
    // and the two tests above would still pass.
    const site = read("src/lib/seo/site.ts");
    for (const sym of [
      "SITE_URL",
      "OG_IMAGE_WIDTH",
      "OG_IMAGE_HEIGHT",
      "OG_IMAGE_TYPE",
      "DEFAULT_OG_IMAGE_PATH",
      "DEFAULT_OG_IMAGE_ALT",
      "normalizePath",
      "absoluteUrl",
    ]) {
      expect(site, `site.ts must still export ${sym}`).toMatch(
        new RegExp(`export (const|function) ${sym}\\b`),
      );
    }
  });
});
