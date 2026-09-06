// US-731: extend automated axe coverage from the public legal pages to the
// highest-traffic entry points — the marketing landing page and the auth
// pages (login / signup). These are the first surfaces most users (and
// assistive-tech users) hit, so a serious/critical regression here is the most
// damaging. Each page is rendered to static markup and checked with axe-core.
//
// color-contrast is disabled (jsdom can't compute layout/styles) — that's
// covered by the AA color tokens + manual review, mirroring the existing axe
// suites. The dummy Supabase env in vitest.config.ts lets the auth pages import
// @/lib/auth (which constructs the Supabase client at import time) without
// throwing; tests never hit the network.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";

import { LandingPage } from "@/pages/landing";
import { LoginPage } from "@/pages/login";
import { SignupPage } from "@/pages/signup";

const PAGES: Array<[string, React.ReactNode]> = [
  ["landing", <LandingPage key="l" />],
  ["login", <LoginPage key="i" />],
  ["signup", <SignupPage key="s" />],
];

async function violations(node: React.ReactNode) {
  // Landing renders data-driven widgets (StatCounters) that call useQuery, so a
  // QueryClientProvider is required; the query never resolves under static
  // render, which is fine — axe only inspects the rendered markup.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
  );
  document.body.innerHTML = html;
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

describe("public entry pages a11y (axe)", () => {
  for (const [name, node] of PAGES) {
    // These are full marketing/auth pages, so axe.run scans a large tree and can
    // take several seconds under full-suite CPU load — a generous timeout keeps
    // it from tripping the 5s default (a mid-run timeout also corrupts axe's
    // global state for the next case).
    it(
      `${name} page has no serious/critical axe violations`,
      async () => {
        const v = await violations(node);
        const summary = v.map((x) => `${x.id}: ${x.help}`).join("; ");
        expect(v, summary).toEqual([]);
      },
      30000,
    );
  }
});
