import type { MouseEvent } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";

// The one place a help article body is injected into the app.
//
// What makes this safe is on the server, not here: sanitizeHtml
// (services/edge-functions/src/lib/content-sanitize.ts) runs in buildPatch when
// an admin saves, and again in projectArticle on EVERY read, because the seed
// and migrate scripts write rows through PostgREST without passing buildPatch.
// Every /api/help and /api/content/public/help response is built by
// projectArticle, so every body that reaches this component has been through
// the allowlist.
//
// Kept as one component so body features are written once instead of once per
// surface. The first is links: article bodies link to each other as
// /help/<category>/<slug>, which inside the app used to be a full page load
// out to the public site, and a members-only target 404s there.

// /help/<category>/<slug>, with an optional trailing slash, query or hash.
const HELP_ARTICLE_PATH = /^\/help\/[a-z0-9-]+\/([a-z0-9-]+)\/?$/;

// Same-origin paths the SPA does not render: files and the API.
const NOT_AN_APP_ROUTE = /^\/api\/|\.[a-z0-9]+$/i;

interface HelpArticleBodyProps {
  html: string;
  className?: string;
  /**
   * Where an in-body link to another help article should go, given its slug.
   * The in-app surfaces pass `slug => /dashboard/help/${slug}`; without it a
   * /help/... link stays a /help/... route.
   */
  linkFor?: (slug: string) => string;
}

export function HelpArticleBody({ html, className, linkFor }: HelpArticleBodyProps) {
  const navigate = useNavigate();

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor || !e.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const target = anchor.getAttribute("target");
    if ((target && target !== "_self") || anchor.hasAttribute("download")) return;

    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (NOT_AN_APP_ROUTE.test(url.pathname)) return;
    // A same-page #section link is the browser's job.
    if (url.pathname === window.location.pathname && url.hash) return;

    const match = HELP_ARTICLE_PATH.exec(url.pathname);
    e.preventDefault();
    if (match && linkFor) {
      void navigate(`${linkFor(match[1]!)}${url.hash}`);
      return;
    }
    void navigate(`${url.pathname}${url.search}${url.hash}`);
  };

  return (
    // The body is prose with ordinary links in it; this only upgrades a click
    // on one of those links to an in-app navigation. Keyboard activation of a
    // link fires the same click event, so nothing here needs a key handler.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={cn("prose prose-slate dark:prose-invert", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
