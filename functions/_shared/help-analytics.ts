// Counting a read of a public help article (US-2592).
//
// The public help pages are server-rendered and the React app never mounts on
// them, which is exactly why they index well and exactly why posthog-js is not
// there to see them. If the only view data came from PostHog, "top articles"
// would rank in-app reading and omit the organic traffic the help centre exists
// to earn. So the view is counted here, server-side, with no identity attached.
//
// GA4 already runs on these pages and already counts pageviews. This is not a
// replacement for it: GA4's numbers live in a third-party dashboard behind a
// consent default of denied, and the admin report has to work without either.

import { edgeApi, type PagesEnv } from "./blog-render";

/**
 * GA4 content_group for every help URL (US-2592 AC4).
 *
 * The point is separability: with a content group, "how is the help centre
 * doing" is one dimension in GA4 rather than a `/help/` URL-prefix filter that
 * somebody has to remember to apply and that nobody applies consistently. The
 * blog and the marketing pages keep their own numbers.
 *
 * The Search Console half of the same requirement is sitemap-help.xml (US-2579),
 * which is already its own sitemap: Search Console reports per sitemap, so help
 * URLs are a group there without any further tagging.
 */
export const HELP_CONTENT_GROUP = "help";

/**
 * Crawlers, previewers and monitors, matched loosely on purpose.
 *
 * A help centre's traffic is a large share of robots, and a "top articles" list
 * that ranks whatever Googlebot crawled most recently answers no question
 * anybody has. This filter is deliberately BROAD: over-excluding costs a few
 * real readers from the count, while under-excluding turns the whole table into
 * a crawl log. It runs on a lowercased user agent.
 */
const BOT_UA = [
  "bot",
  "crawl",
  "spider",
  "slurp",
  "curl",
  "wget",
  "python-requests",
  "httpclient",
  "headlesschrome",
  "lighthouse",
  "pagespeed",
  "preview",
  "monitor",
  "uptime",
  "facebookexternalhit",
  "embedly",
  "quora link preview",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "slackbot",
  "vercel",
  "prerender",
  "chatgpt",
  "gptbot",
  "claude",
  "perplexity",
  "anthropic",
];

/**
 * Extract the article slug from a help URL, or null when the URL is not an
 * article page.
 *
 * The `.md` mirror is deliberately NOT counted. It exists for answer engines to
 * ingest whole, and counting it would put the articles a crawler happened to
 * fetch at the top of a list meant to show what people read.
 *
 * It lives here rather than in the Function so a test can import it without
 * pulling the Cloudflare Workers global types into the app's tsconfig program.
 */
export function helpArticleSlugForCount(pathname: string): string | null {
  const path = pathname.replace(/\/$/, "");
  const segments = path.replace(/^\/help\/?/, "").split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const slug = segments[1];
  if (!slug || slug.endsWith(".md")) return null;
  return /^[a-z0-9-]{1,80}$/.test(slug) ? slug : null;
}

/**
 * Whether this request should be counted as somebody reading the article.
 *
 * An EMPTY user agent is not counted. Real browsers always send one; a request
 * without it is a script, and treating the unknown as human is how a table of
 * "views" becomes a table of whatever ran that week.
 */
export function isCountableView(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (!ua) return false;
  return !BOT_UA.some((needle) => ua.includes(needle));
}

/**
 * Fire-and-forget the view counter.
 *
 * Called inside waitUntil, AFTER the HTML has already been sent. It has no way
 * to affect what the reader saw, which is the only acceptable arrangement for
 * analytics on a page whose whole job is to load fast.
 *
 * Note this runs on a cache HIT too: withEdgeCache returns a stored response
 * from inside the Function, so the Function still executes. If the view were
 * counted by the renderer instead, every cached read would go uncounted and the
 * most popular articles would be the most under-reported.
 */
export function countHelpArticleView(
  env: PagesEnv,
  slug: string,
  userAgent: string | null | undefined,
): Promise<void> | null {
  if (!isCountableView(userAgent)) return null;
  const safe = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(safe)) return null;

  const headers: Record<string, string> = { Accept: "application/json" };
  // US-781: identify the Pages origin so the public rate limiter does not treat
  // every visitor's read as coming from one address.
  const originSecret = env.CF_PAGES_ORIGIN_SECRET?.trim();
  if (originSecret) headers["x-pages-origin"] = originSecret;

  return fetch(
    `${edgeApi(env)}/api/content/public/help/${encodeURIComponent(safe)}/view`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    } as RequestInit,
  ).then(
    () => {},
    (e: unknown) => {
      // A lost count under-reports. A thrown error inside waitUntil would be a
      // Function error on a page that has already been delivered.
      console.warn("[help/view] count failed:", e);
    },
  );
}
