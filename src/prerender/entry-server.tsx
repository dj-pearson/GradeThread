// SSR entry used only by the build-time prerender (US-292). It renders a single
// public route's React tree to a static HTML body string. The prerender script
// (scripts/prerender.mjs) loads this via Vite's SSR pipeline, injects the body
// + the registry-driven <head> (head-builder.ts) into the built index.html
// template, and writes dist/<route>/index.html.
//
// No browser is required, and this is not cloaking: the SAME prerendered HTML is
// served to every visitor. On the client, main.tsx mounts with createRoot (not
// hydrateRoot), so React simply re-renders over the static shell into the live
// SPA — no hydration-mismatch warnings.
//
// We render each public page directly inside a StaticRouter (giving <Link> its
// context) rather than through the lazy app router. The pages already carry
// their own chrome (landing has its header/footer; legal pages use LegalLayout),
// and RootLayout only adds the Toaster + dialogs + cookie banner, which all
// render nothing meaningful server-side. This keeps the SSR bundle free of the
// auth/dashboard/supabase graph.

import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LandingPage } from "@/pages/landing";
import { PrivacyPage } from "@/pages/legal/privacy";
import { TermsPage } from "@/pages/legal/terms";
import { CookiesPage } from "@/pages/legal/cookies";
import { AcceptableUsePage } from "@/pages/legal/acceptable-use";
import { HowItWorksPage } from "@/pages/marketing/how-it-works";
import { PricingPage } from "@/pages/marketing/pricing";
import { ForResellersPage } from "@/pages/marketing/for-resellers";
import { FaqPage } from "@/pages/marketing/faq";
import { ConditionGradingPage } from "@/pages/marketing/condition-grading";
import { GradingGlossaryPage } from "@/pages/marketing/grading-glossary";
import { GLOSSARY_ENTRIES } from "@/lib/seo/glossary";

// Static map of prerenderable routes → page element.
const PAGES: Record<string, React.ReactNode> = {
  "/": <LandingPage />,
  "/how-it-works": <HowItWorksPage />,
  "/pricing": <PricingPage />,
  "/for-resellers": <ForResellersPage />,
  "/faq": <FaqPage />,
  "/condition-grading": <ConditionGradingPage />,
  "/privacy": <PrivacyPage />,
  "/terms": <TermsPage />,
  "/cookies": <CookiesPage />,
  "/acceptable-use": <AcceptableUsePage />,
  // Glossary hub (US-303): the /grading/:slug route resolves its slug from
  // useParams at runtime; here we render each entry with an explicit slug prop
  // since the prerender renders a path directly with no router param match.
  ...Object.fromEntries(
    GLOSSARY_ENTRIES.map((e) => [
      e.path,
      <GradingGlossaryPage key={e.slug} slug={e.slug} />,
    ]),
  ),
};

export function renderRoute(path: string): string {
  const page = PAGES[path];
  if (!page) {
    throw new Error(`[prerender] no page registered for "${path}"`);
  }
  // A throwaway QueryClient: public pages read no server state, but the
  // provider must exist for any incidental hooks.
  const queryClient = new QueryClient();
  return renderToString(
    <StrictMode>
      <HelmetProvider>
        <QueryClientProvider client={queryClient}>
          <StaticRouter location={path}>{page}</StaticRouter>
        </QueryClientProvider>
      </HelmetProvider>
    </StrictMode>,
  );
}

// The set of paths this entry can render — the prerender script asserts this
// matches the route registry so a new public route can't silently skip SSR.
export const PRERENDERABLE_PATHS = Object.keys(PAGES);
