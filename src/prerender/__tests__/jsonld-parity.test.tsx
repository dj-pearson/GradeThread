import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
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
import { DownloadPage } from "@/pages/marketing/download";
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
        QueryClientProvider,
        { client: queryClient },
        h(
          MemoryRouter,
          { initialEntries: [path] },
          h(Suspense, { fallback: null }, h(Page, props)),
        ),
      ),
    );
  });
  // Flush the macrotask the SEO effects use.
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
  // US-3117: three SoftwareApplication entries plus the download FAQ.
  ["download", DownloadPage, "/download"],
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

// ── US-2105 AC3: close the other half of the US-2044 hole ───────────
//
// The guard above walks the registry and checks that a DECLARED jsonLdType is
// actually prerendered. It can only check routes that declare one — and 19 of
// 213 declare nothing, so they sit entirely outside it.
//
// That narrows the US-2044 regression rather than eliminating it. Adding
// <SEO jsonLd={...}> to any undeclared route ships markup that exists ONLY in
// the SPA: react-helmet-async v3 renders no server-side head, so <SEO> injects
// JSON-LD via useEffect and the prerendered HTML a non-JS crawler sees carries
// nothing. CI stays green, the page looks correct in a browser, and the
// structured data is invisible to exactly the consumers it was written for.
//
// This asserts the inverse direction: a page that passes jsonLd MUST declare a
// jsonLdType, so the guard above then picks it up automatically.
describe("US-2105: a page passing jsonLd must declare a jsonLdType", () => {
  it("no undeclared route ships SPA-only structured data", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { PUBLIC_ROUTES } = await import("@/lib/seo/public-routes");

    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const router = read("src/routes/index.tsx");

    // component name → page source file
    const componentFile = new Map<string, string>();
    for (const m of router.matchAll(
      /const (\w+) = lazy\(\(\) => import\("@\/(pages\/[^"]+)"\)/g,
    )) {
      componentFile.set(m[1]!, `src/${m[2]!}`);
    }
    // route path → component name (first binding wins)
    const pathComponent = new Map<string, string>();
    for (const m of router.matchAll(/\{\s*path:\s*"([^"]+)"[\s\S]{0,200}?<(\w+)\s*\/>/g)) {
      if (!pathComponent.has(m[1]!)) pathComponent.set(m[1]!, m[2]!);
    }
    // The mapping is the load-bearing part — if the router's shape changes and
    // this silently resolves nothing, the guard passes while checking zero
    // files, which is the failure mode it exists to prevent.
    expect(
      componentFile.size,
      "could not parse lazy() page bindings out of src/routes/index.tsx",
    ).toBeGreaterThan(50);
    expect(pathComponent.size).toBeGreaterThan(50);

    // The router imports without a file extension ("@/pages/marketing/for-brands"),
    // so the module path has to be resolved to a real file. An earlier version of
    // this guard did `try { read(file) } catch { continue }` — every read threw,
    // every route was skipped, and the guard reported green while checking
    // NOTHING. That is precisely the failure it exists to catch, so an
    // unresolvable page is now a hard failure rather than a silent skip.
    const resolve = (base: string): string | null => {
      for (const ext of [".tsx", ".ts"]) {
        try {
          read(base + ext);
          return base + ext;
        } catch {
          /* try next */
        }
      }
      return null;
    };

    const offenders: string[] = [];
    const unresolved: string[] = [];
    let checked = 0;
    for (const route of PUBLIC_ROUTES) {
      if ((route as { jsonLdType?: string }).jsonLdType) continue;
      const comp = pathComponent.get(route.path);
      const base = comp ? componentFile.get(comp) : undefined;
      if (!base) continue; // SSR'd or non-lazy route; not in scope here
      const file = resolve(base);
      if (!file) {
        unresolved.push(`${route.path} -> ${base}`);
        continue;
      }
      checked++;
      if (/jsonLd\s*[=:]/.test(read(file))) offenders.push(`${route.path} (${file})`);
    }

    expect(
      unresolved,
      "could not resolve these page modules to a file — the guard would " +
        "silently check nothing for them: " + unresolved.join(", "),
    ).toEqual([]);
    // Proof the guard actually inspected the undeclared routes rather than
    // skipping them all and passing vacuously.
    expect(checked, "the guard inspected no page files at all").toBeGreaterThan(10);

    expect(
      offenders,
      "These routes pass jsonLd in the page but declare no jsonLdType in " +
        "PUBLIC_ROUTES, so the markup is SPA-only and the US-2044 parity guard " +
        "cannot see it. Add a jsonLdType to the registry AND mirror the markup " +
        "in head-builder.ts jsonLdForRoute():\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });
});
