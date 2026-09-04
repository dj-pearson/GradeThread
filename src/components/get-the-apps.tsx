import { Chrome, Smartphone, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { appLinks, appLinksFor, type AppLink, type AppLinkId } from "@/lib/app-links";

// US-3110: GradeThread ships in three places and the site mentioned none of
// them. The iOS app had no link anywhere outside the billing page's "manage
// your subscription" text, and both extensions were reachable only from the
// cross-listing UI, which a seller has to already be deep inside FlipDesk to
// see. This component is the one answer to "where do I get it", rendered in the
// two footers, on the dashboard board and on the onboarding welcome.
//
// The links are the same three everywhere; only the shape changes.

const ICONS: Record<AppLinkId, typeof Smartphone> = {
  ios: Smartphone,
  chrome: Chrome,
  firefox: Puzzle,
};

function currentUa(): string | null {
  return typeof navigator !== "undefined" ? navigator.userAgent : null;
}

function onClick(link: AppLink, surface: string) {
  track("app_download_click", { app: link.id, surface });
}

/**
 * A vertical list of plain links, sized and coloured to sit inside the marketing
 * footer's existing columns.
 *
 * Order is fixed rather than user-agent sorted. A footer lists all three every
 * time and reordering them per browser would make the same page look different
 * to two people for no benefit.
 */
export function AppDownloadLinks({ surface }: { surface: string }) {
  return (
    <>
      {appLinks().map((link) => (
        <a
          key={link.id}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground"
          onClick={() => onClick(link, surface)}
        >
          {link.label}
        </a>
      ))}
    </>
  );
}

/**
 * A horizontal row of the same three, for a footer that has no columns (the
 * landing page) or any strip that wants them inline.
 */
export function AppDownloadRow({
  surface,
  className,
}: {
  surface: string;
  className?: string;
}) {
  return (
    <div className={className ?? "flex flex-wrap items-center gap-2"}>
      {appLinks().map((link) => {
        const Icon = ICONS[link.id];
        return (
          <Button key={link.id} asChild variant="outline" size="sm">
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onClick(link, surface)}
            >
              <Icon className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {link.label}
            </a>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The explained version: what each one is for, with its own button.
 *
 * Renders bare rows, no Card of its own — it goes inside surfaces that already
 * draw one (the dashboard widget frame, the onboarding dialog), and a card
 * inside a card is the tell this codebase's UI check exists to catch.
 *
 * This is the one place the order follows the user agent, because a card is
 * read top to bottom and the first row is the one being recommended.
 */
export function AppDownloadList({ surface }: { surface: string }) {
  const links = appLinksFor(currentUa());
  return (
    <ul className="divide-y">
      {links.map((link) => {
        const Icon = ICONS[link.id];
        return (
          <li
            key={link.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 items-start gap-3">
              <Icon
                className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">{link.label}</p>
                <p className="text-xs text-muted-foreground">{link.blurb}</p>
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onClick(link, surface)}
              >
                {link.cta}
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
