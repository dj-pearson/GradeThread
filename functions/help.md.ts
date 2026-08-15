// /help.md — the whole Help Center as one clean Markdown page (US-2575).
//
// Its own Function rather than a branch of functions/help/[[path]].ts, because a
// [[path]] catch-all under functions/help/ matches /help and /help/*, and
// /help.md is neither. Same reason functions/llms.txt.ts and functions/rss.xml.ts
// sit at the root.
//
// Answer engines read a Markdown index far more reliably than they crawl a card
// grid, and this one is the single hop that lists every public article with its
// summary and its URL. Only public articles ever appear: the upstream it calls
// cannot return anything else.

import {
  fetchJson,
  siteUrl,
  SSR_CACHE_CONTROL,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  withEdgeCache,
  type PagesEnv,
} from "./_shared/blog-render";
import {
  buildHelpIndexMarkdown,
  type HelpIndexPayload,
} from "./_shared/help-render";

type Ctx = EventContext<PagesEnv, string, Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => renderHelpIndexMarkdown(context.env));

async function renderHelpIndexMarkdown(env: PagesEnv): Promise<Response> {
  let index: HelpIndexPayload | null;
  try {
    index = await fetchJson<HelpIndexPayload>(env, "/api/content/public/help");
  } catch (err) {
    if (err instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw err;
  }
  if (!index) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return new Response(buildHelpIndexMarkdown(index, siteUrl(env)), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": SSR_CACHE_CONTROL,
    },
  });
}
