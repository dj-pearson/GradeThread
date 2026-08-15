import { Link } from "react-router";
import { LifeBuoy } from "lucide-react";
import { HELP_CATEGORIES, helpCategoryPath } from "@/types/help-center";
import { cn } from "@/lib/utils";

// US-2582: the marketing-page uplink into the Help Center.
//
// 213 marketing routes already rank. A help center nothing links to is an
// orphan no matter how good the writing is, and the links have to run BOTH ways
// or only one side of the graph benefits: the article names its pillar
// (renderPillarLink), and the pillar names the shelf.
//
// The category key is checked against HELP_CATEGORIES at the type level, so a
// renamed or removed shelf is a build error here rather than a 404 a visitor
// finds first.

type HelpCategoryKey = (typeof HELP_CATEGORIES)[number]["key"];

interface HelpCategoryLinkProps {
  /** Which shelf this page sends readers to. */
  category: HelpCategoryKey;
  /** Overrides the default sentence. Keep it about what they will find. */
  label?: string;
  className?: string;
}

export function HelpCategoryLink({ category, label, className }: HelpCategoryLinkProps) {
  const entry = HELP_CATEGORIES.find((c) => c.key === category);
  // Belt and braces for a JS caller that slipped past the type: render nothing
  // rather than a link to /help/undefined.
  if (!entry) return null;

  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      <LifeBuoy className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden="true" />
      {label ?? `Step-by-step guides:`}{" "}
      <Link
        to={helpCategoryPath(entry.slug)}
        className="font-medium text-brand-navy hover:underline dark:text-foreground"
      >
        {entry.title} in the Help Center
      </Link>
      .
    </p>
  );
}
