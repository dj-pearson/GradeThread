// US-2103 AC4/AC5: the brand entity graph actually connects.
//
// marketing-jsonld.ts emitted the brand as INLINE LITERAL nodes —
// {"@type":"Organization", name:"GradeThread"} — rather than as references to
// ORG_ID. Those are anonymous nodes: a consumer cannot tell they are the same
// organization as the site-wide one, so every publisher/provider edge pointed
// at a fresh unnamed entity and none of it accrued to the brand. The certificate
// Product had the same problem and is the one that matters most, since the
// certificate IS the product claim.
//
// The fix is not uniform, which is the point of testing it rather than eyeballing
// it. There are two correct shapes and using the wrong one breaks the markup:
//
//   BARE REFERENCE  {"@id": ORG_ID}  — valid only where the Organization node is
//     actually present. organizationLd() is emitted by marketing-layout,
//     legal-layout and every prerender head, so it is on every public page.
//
//   INLINE + @id  {"@type": …, "@id": …, name, url} — required where the target
//     node is NOT on the page. webSiteLd() is emitted ONLY on the home route, and
//     the cert page emits only Product + Breadcrumb. A bare reference there would
//     DANGLE: a pointer to a node the document never defines, which is strictly
//     worse than the anonymous node it replaced.

import { describe, expect, it } from "vitest";
import { ORG_ID, WEBSITE_ID, certificateLd, passportLd } from "@/lib/seo/json-ld";
import * as marketing from "@/pages/marketing/marketing-jsonld";
import { FLIPDESK_LANDINGS } from "@/lib/seo/flipdesk-landing";
import type { JsonLd } from "@/lib/seo/json-ld";

/** Every node in a JSON-LD tree, so a nested publisher/provider can't hide. */
function walk(node: unknown, out: Record<string, unknown>[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (node && typeof node === "object") {
    out.push(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
}

/** Nodes that name the brand but carry no @id — the defect this story is about. */
function anonymousBrandNodes(ld: JsonLd[] | JsonLd) {
  return walk(ld).filter(
    (n) =>
      (n["@type"] === "Organization" || n["@type"] === "WebSite") &&
      !("@id" in n),
  );
}

describe("US-2103: brand nodes merge into one entity", () => {
  // DERIVED, not enumerated. A hand-listed set of builders is how this guard
  // fails silently: the first version of this test listed five pages, none of
  // which happened to contain the sites being fixed, and passed against a
  // deliberately reintroduced anonymous node. Every zero-arg *JsonLd export is
  // swept, so a NEW builder is covered the day it is added rather than the day
  // someone remembers to list it.
  const PAGES: Array<[string, JsonLd[]]> = Object.entries(marketing)
    .filter(
      ([name, fn]) =>
        name.endsWith("JsonLd") && typeof fn === "function" && fn.length === 0,
    )
    .map(([name, fn]) => [name, (fn as () => JsonLd[])()]);

  // The per-item builders take an argument, so the sweep above cannot reach
  // them. flipdeskLandingJsonLd carries both an isPartOf and a publisher, which
  // makes it the highest-value one to cover explicitly.
  for (const landing of FLIPDESK_LANDINGS) {
    PAGES.push([
      `flipdeskLandingJsonLd(${landing.slug})`,
      marketing.flipdeskLandingJsonLd(landing),
    ]);
  }

  it("sweeps a non-trivial number of builders (guards the filter itself)", () => {
    expect(PAGES.length).toBeGreaterThan(15);
  });

  it.each(PAGES)(
    "%s mints no anonymous Organization/WebSite node",
    (_path, ld) => {
      expect(anonymousBrandNodes(ld)).toEqual([]);
    },
  );

  it("publisher/provider edges point at ORG_ID", () => {
    for (const [path, ld] of PAGES) {
      for (const node of walk(ld)) {
        for (const key of ["publisher", "provider", "creator"]) {
          const edge = node[key] as Record<string, unknown> | undefined;
          if (!edge) continue;
          expect(edge["@id"], `${path} ${key}`).toBe(ORG_ID);
        }
      }
    }
  });

  // The WebSite node is NOT on these pages, so isPartOf must stay self-contained
  // while still carrying the id. Asserting `name` here is deliberate: it is what
  // distinguishes "inline node that merges" from "dangling pointer".
  it("isPartOf carries WEBSITE_ID inline rather than as a bare reference", () => {
    for (const [path, ld] of PAGES) {
      for (const node of walk(ld)) {
        const edge = node.isPartOf as Record<string, unknown> | undefined;
        if (!edge) continue;
        expect(edge["@id"], `${path} isPartOf`).toBe(WEBSITE_ID);
        expect(edge["@type"], `${path} isPartOf`).toBe("WebSite");
        expect(edge.name, `${path} isPartOf`).toBe("GradeThread");
      }
    }
  });
});

describe("US-2103 AC5: certificate/passport Products reach the brand graph", () => {
  const CERT = certificateLd({
    id: "abc123",
    title: "Vintage Levi's 501",
    overallScore: 8.5,
    gradeTier: "Excellent",
  });
  const PASSPORT = passportLd({
    slug: "abc123",
    name: "Nike Shirt",
    latestGrade: { score: 8.5, tier: "Excellent" },
  });

  it.each([
    ["certificate", CERT],
    ["passport", PASSPORT],
  ])("%s review author is inline AND carries ORG_ID", (_name, ld) => {
    const author = (ld.review as Record<string, unknown>).author as Record<
      string,
      unknown
    >;
    // Merges with the site-wide Organization…
    expect(author["@id"]).toBe(ORG_ID);
    // …without becoming a pointer to a node this page never emits.
    expect(author["@type"]).toBe("Organization");
    expect(author.name).toBe("GradeThread");
    expect(author.url).toBeTruthy();
  });

  it.each([
    ["certificate", CERT],
    ["passport", PASSPORT],
  ])("%s mints no anonymous brand node", (_name, ld) => {
    expect(anonymousBrandNodes(ld)).toEqual([]);
  });
});
