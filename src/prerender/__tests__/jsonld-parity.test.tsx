import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";

import { jsonLdForRoute } from "../head-builder";
import { glossaryRoutes } from "@/lib/seo/glossary";

import { LandingPage } from "@/pages/landing";
import { HowItWorksPage } from "@/pages/marketing/how-it-works";
import { PricingPage } from "@/pages/marketing/pricing";
import { FaqPage } from "@/pages/marketing/faq";
import { ConditionGradingPage } from "@/pages/marketing/condition-grading";
import { GradingStandardPage } from "@/pages/marketing/grading-standard";
import { TransparencyPage } from "@/pages/marketing/transparency";
import { ResaleConditionReportPage } from "@/pages/marketing/resale-condition-report";
import { WhatsItWorthPage } from "@/pages/marketing/whats-it-worth";
import { ReduceReturnsPage } from "@/pages/marketing/reduce-returns";
import { ResellerGradingGuidePage } from "@/pages/marketing/reseller-grading-guide";
import { DesignVsDamagePage } from "@/pages/marketing/design-vs-damage";
import { ResaleValueByConditionPage } from "@/pages/marketing/resale-value-by-condition";
import { GradingByCategoryPage } from "@/pages/marketing/grading-by-category";
import { AboutPage } from "@/pages/marketing/about";
import { GradingGlossaryPage } from "@/pages/marketing/grading-glossary";

// US-423 / AC3: the build-time prerender is string-based (head-builder.ts), so a
// page's runtime <SEO jsonLd> and the prerendered jsonLdForRoute() must stay
// IDENTICAL or crawlers get different (or zero) structured data than humans.
// This test renders each indexable page the way the SPA does, reads the JSON-LD
// it injects into <head> via useEffect, and asserts it matches head-builder.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderAt(
  Page: ComponentType<Record<string, unknown>>,
  path: string,
  props: Record<string, unknown> = {},
): Promise<unknown[]> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Some pages (e.g. /transparency) call useQuery, so a QueryClient must be in
  // scope. Retries off + a no-op fetch keep the render deterministic; the LD we
  // assert on is static and emitted regardless of the query's result.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      h(
        HelmetProvider,
        null,
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            MemoryRouter,
            { initialEntries: [path] },
            h(Suspense, { fallback: null }, h(Page, props)),
          ),
        ),
      ),
    );
  });
  // Flush the rAF/macrotask the SEO effect + helmet use.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return [
    ...document.head.querySelectorAll("script[data-seo-jsonld='true']"),
  ].map((n) => JSON.parse(n.textContent || "null"));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.head
    .querySelectorAll("script[type='application/ld+json']")
    .forEach((n) => n.remove());
});

/** Order-insensitive multiset compare of JSON-LD node lists. */
function canonical(nodes: unknown[]): string[] {
  return nodes.map((n) => JSON.stringify(n)).sort();
}

const CASES: Array<[string, ComponentType<Record<string, unknown>>, string]> = [
  ["home", LandingPage, "/"],
  ["how-it-works", HowItWorksPage, "/how-it-works"],
  ["pricing", PricingPage, "/pricing"],
  ["faq", FaqPage, "/faq"],
  ["condition-grading", ConditionGradingPage, "/condition-grading"],
  ["grading-standard", GradingStandardPage, "/grading-standard"],
  ["transparency", TransparencyPage, "/transparency"],
  ["resale-condition-report", ResaleConditionReportPage, "/resale-condition-report"],
  ["whats-it-worth", WhatsItWorthPage, "/whats-it-worth"],
  ["reduce-returns", ReduceReturnsPage, "/reduce-returns"],
  ["reseller-grading-guide", ResellerGradingGuidePage, "/reseller-grading-guide"],
  ["design-vs-damage", DesignVsDamagePage, "/design-vs-damage"],
  ["resale-value-by-condition", ResaleValueByConditionPage, "/resale-value-by-condition"],
  ["grading-by-category", GradingByCategoryPage, "/grading-by-category"],
  ["about", AboutPage, "/about"],
];

describe("JSON-LD prerender parity (US-423)", () => {
  it.each(CASES)("%s runtime LD == head-builder LD", async (_name, Page, path) => {
    const runtime = await renderAt(Page, path);
    const built = jsonLdForRoute(path);
    expect(runtime.length).toBeGreaterThan(0);
    expect(canonical(runtime)).toEqual(canonical(built));
  });

  it("a glossary spoke's runtime LD == head-builder LD", async () => {
    const route = glossaryRoutes()[0]!;
    const slug = route.path.replace("/grading/", "");
    const runtime = await renderAt(
      GradingGlossaryPage as ComponentType<Record<string, unknown>>,
      route.path,
      { slug },
    );
    const built = jsonLdForRoute(route.path);
    expect(runtime.length).toBeGreaterThan(0);
    expect(canonical(runtime)).toEqual(canonical(built));
  });

  // US-973: the glossary spoke must emit a DefinedTerm linked to the hub set,
  // and the /condition-grading hub must emit the DefinedTermSet listing terms.
  it("a glossary spoke emits a DefinedTerm linked to the condition-glossary set (US-973)", () => {
    const route = glossaryRoutes()[0]!;
    const built = jsonLdForRoute(route.path) as Array<Record<string, unknown>>;
    const term = built.find((n) => n["@type"] === "DefinedTerm");
    expect(term).toBeDefined();
    expect(term!.inDefinedTermSet).toBe(
      "https://gradethread.com/#condition-glossary",
    );
    expect(term!.url).toBe(`https://gradethread.com${route.path}`);
  });

  it("the /condition-grading hub emits a DefinedTermSet with every term (US-973)", () => {
    const built = jsonLdForRoute("/condition-grading") as Array<
      Record<string, unknown>
    >;
    const set = built.find((n) => n["@type"] === "DefinedTermSet");
    expect(set).toBeDefined();
    expect(set!["@id"]).toBe("https://gradethread.com/#condition-glossary");
    const terms = set!.hasDefinedTerm as unknown[];
    // 7 tiers + 5 factors.
    expect(terms.length).toBe(glossaryRoutes().length);
    expect(terms.length).toBe(12);
  });
});

// ── US-2044: REGISTRY-WIDE parity, not a hand-maintained list ────────────
//
// The suite above imports 16 page components by hand. That list has not kept up
// with the site: of 213 registered routes, the newer families (tools, flipdesk
// landings, comparisons, reselling guides, flaw library, garment guides,
// platform standards, returns, durability) are entirely unguarded. Adding a page
// with <SEO jsonLd={…}> and forgetting head-builder.ts produced a GREEN CI —
// which is exactly how /state-of-durability and both /tools/* calculators ended
// up shipping their structured data to the SPA only, invisible to every
// non-JS crawler (Google's HTML pass, GPTBot, ClaudeBot, PerplexityBot).
//
// CLAUDE.md claims "the mirror is enforced by jsonld-parity.test.tsx". This is
// the assertion that makes that sentence true.
//
// Deliberately checks the REGISTRY's declared jsonLdType against what the
// prerenderer actually emits, rather than rendering all 213 components: it is
// cheap, it needs no per-page wiring, and it catches the real failure — a route
// that promises a type and prerenders nothing.
describe("US-2044: every route's declared jsonLdType is actually prerendered", () => {
  it("emits the declared @type for each route that declares one", async () => {
    const { PUBLIC_ROUTES } = await import("@/lib/seo/public-routes");

    const missing: string[] = [];
    for (const route of PUBLIC_ROUTES) {
      const declared = (route as { jsonLdType?: string }).jsonLdType;
      if (!declared) continue;
      // jsonLdForRoute returns a JsonLd[] — collect every @type it emits,
      // including nested ones (an Article's mainEntity, a FAQPage's Questions),
      // since a declared type can legitimately appear nested rather than at the
      // top level.
      const emitted = jsonLdForRoute(route.path) ?? [];
      const types = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        const t = (node as { "@type"?: unknown })["@type"];
        if (typeof t === "string") types.add(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
        Object.values(node as Record<string, unknown>).forEach(walk);
      };
      walk(emitted);

      if (!types.has(declared)) {
        missing.push(
          `${route.path} declares ${declared} but prerenders [${[...types].join(", ")}]`,
        );
      }
    }

    expect(
      missing,
      "These routes declare a jsonLdType the prerenderer does not emit, so the " +
        "markup exists only in the SPA and no non-JS crawler can see it:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });
});
