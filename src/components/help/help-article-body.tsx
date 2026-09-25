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
// Kept as one component so later body features (in-app links, anchors) are
// written once instead of once per surface.

interface HelpArticleBodyProps {
  html: string;
  className?: string;
}

export function HelpArticleBody({ html, className }: HelpArticleBodyProps) {
  return (
    <div
      className={cn("prose prose-slate dark:prose-invert", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
