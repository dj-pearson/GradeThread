import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { SITE_URL } from "@/lib/seo/public-routes";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  name: string;
  /** Absolute (SITE_URL-prefixed) or root-relative URL — matches the JSON-LD. */
  url: string;
}

interface BreadcrumbsProps {
  /**
   * The SAME trail passed to breadcrumbLd() so the visible nav matches the
   * BreadcrumbList JSON-LD exactly (US-433). Root → … → current page.
   */
  items: ReadonlyArray<BreadcrumbItem>;
  className?: string;
}

/** Absolute SITE_URL links → root-relative paths so client routing works. */
function toRelative(url: string): string {
  if (url.startsWith(SITE_URL)) return url.slice(SITE_URL.length) || "/";
  return url;
}

// Visible breadcrumb trail (US-433). Renders the same {name,url} items emitted
// in the page's BreadcrumbList JSON-LD, so crawlers and humans see one matching
// hierarchy signal. The final item is the current page (plain text,
// aria-current); earlier items are links. Nothing renders for a single item.
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (items.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn("text-sm text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={item.url} className="flex items-center gap-1.5">
              {i > 0 && (
                <ChevronRight aria-hidden className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
              )}
              {isLast ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {item.name}
                </span>
              ) : (
                <Link to={toRelative(item.url)} className="hover:text-foreground hover:underline">
                  {item.name}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
