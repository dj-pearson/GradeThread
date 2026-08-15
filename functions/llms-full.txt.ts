// /llms-full.txt — the COMPLETE grading standard in a single fetch (US-2106).
//
// vault/40-growth/seo-geo-strategy.md §6.4 asks for this alongside /llms.txt:
// llms.txt is a MAP of the site, this is the TERRITORY. An answer engine can
// ingest the whole standard — scale, tiers, factor weights, measurable
// tolerances, glossary, reseller vocabulary, flaw library — without crawling
// 40+ separate pages.
//
// Everything is derived at build time into dist/llms-full-data.json from the
// same constants the public pages render, so this file cannot drift from the
// site and nothing here is hand-maintained. It adds no indexable page surface.
//
// US-2580: the HELP CENTER is deliberately NOT folded in here. Help articles are
// database rows an admin edits without a deploy, so injecting them would trade
// this file's one real guarantee — that it cannot drift from the build — for a
// live fetch that can fail halfway. Its equivalent is /help.md, which carries
// every public article in full from the same anonymous endpoint the help pages
// read, and which /llms.txt names in its Help Center section.

import { siteUrl, type PagesEnv } from "./_shared/blog-render";
import { buildLlmsFullTxt, type LlmsFullData } from "./_shared/seo-config";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const base = siteUrl(env);

  // Same-origin build artifact, exactly as llms.txt consumes seo-manifest.json.
  const res = await fetch(`${base}/llms-full-data.json`, {
    signal: AbortSignal.timeout(8_000),
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);

  if (!res.ok) {
    // US-2097's lesson: a partial standard is worse than none. Half a grading
    // spec served 200 and cached is a document an answer engine will quote as
    // though it were complete. Fail visibly instead.
    console.error(`[llms-full.txt] build artifact unavailable: ${res.status}`);
    return new Response("llms-full.txt is temporarily unavailable\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300" },
    });
  }

  let data: LlmsFullData;
  try {
    data = (await res.json()) as LlmsFullData;
  } catch (e) {
    console.error("[llms-full.txt] malformed build artifact:", e);
    return new Response("llms-full.txt is temporarily unavailable\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300" },
    });
  }

  return new Response(buildLlmsFullTxt(base, data), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
};
