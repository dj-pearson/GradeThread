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
import { WhatsItWorthPage } from "@/pages/marketing/whats-it-worth";
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
  ["whats-it-worth", WhatsItWorthPage, "/whats-it-worth"],
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
});
