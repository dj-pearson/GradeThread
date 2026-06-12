// /llms.txt — a Markdown map of the site for LLMs / AI answer engines
// (PRD: tasks/prd-seo-hardening.md, US-295; registry-driven in US-431).
//
// The section list is no longer hand-curated: it's derived from the build-emitted
// dist/seo-manifest.json (which IS src/lib/seo/public-routes.ts → PUBLIC_ROUTES),
// the same source the sitemap uses. A new public page therefore auto-appears here
// with no hand-edit, and src/test/llms-txt.test.ts fails CI if a registry route
// goes missing from the output.

import { siteUrl, edgeApi, type PagesEnv } from "./_shared/blog-render";
import {
  buildLlmsTxt,
  buildLlmsSections,
  LLMS_SUMMARY,
  AI_CRAWLER_POLICY_NOTE,
  type LlmsRoute,
} from "./_shared/seo-config";

interface SeoManifest {
  routes: Array<{
    path: string;
    title: string;
    description?: string;
    priority?: number;
  }>;
}
interface CertSitemap {
  certificates: Array<{ id: string }>;
}
interface SellerSitemap {
  sellers: Array<{ handle: string }>;
}

async function fetchJsonSafe<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
      ...init,
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Static fallback so /llms.txt still renders the core map if the manifest asset
// is somehow unavailable (e.g. a partial deploy).
const FALLBACK_ROUTES: LlmsRoute[] = [
  { path: "/", title: "GradeThread home", priority: 1.0 },
  { path: "/how-it-works", title: "How It Works", priority: 0.9 },
  { path: "/pricing", title: "Pricing", priority: 0.9 },
  { path: "/condition-grading", title: "What Is Clothing Condition Grading?", priority: 0.9 },
  { path: "/grading-standard", title: "The GradeThread Grading Standard", priority: 0.8 },
  { path: "/transparency", title: "Grading Accuracy & Transparency Report", priority: 0.8 },
  { path: "/for-resellers", title: "For Resellers", priority: 0.8 },
  { path: "/faq", title: "Frequently Asked Questions", priority: 0.7 },
];

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const base = siteUrl(env);
  const api = edgeApi(env);

  const manifest = await fetchJsonSafe<SeoManifest>(`${base}/seo-manifest.json`);
  const routes: LlmsRoute[] = manifest?.routes?.length
    ? manifest.routes.map((r) => ({
        path: r.path,
        title: r.title,
        description: r.description,
        priority: r.priority,
      }))
    : FALLBACK_ROUTES;

  // Representative dynamic URLs — best-effort, gracefully omitted on failure.
  const [certs, sellers] = await Promise.all([
    fetchJsonSafe<CertSitemap>(`${api}/api/content/public/certificates.json`, {
      headers: { Accept: "application/json" },
    }),
    fetchJsonSafe<SellerSitemap>(`${api}/api/content/public/sellers.json`, {
      headers: { Accept: "application/json" },
    }),
  ]);
  const certUrls = (certs?.certificates ?? []).slice(0, 3).map((cI) => ({
    title: `Verified grade certificate ${cI.id}`,
    url: `/cert/${cI.id}`,
  }));
  const sellerUrls = (sellers?.sellers ?? []).slice(0, 3).map((s) => ({
    title: `Verified seller @${s.handle}`,
    url: `/verified/${s.handle}`,
  }));

  const body = buildLlmsTxt({
    siteUrl: base,
    summary: LLMS_SUMMARY,
    policyNote: AI_CRAWLER_POLICY_NOTE,
    sections: buildLlmsSections({ routes, certUrls, sellerUrls }),
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
