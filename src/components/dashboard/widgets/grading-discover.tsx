import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePassportSummary } from "@/hooks/use-passport-summary";
import { featureCardsFor } from "@/lib/dashboard-persona-cards";

// US-1118's Discover cards, moved onto the widget board by US-3075 AC1. The
// list itself lives in src/lib/dashboard-persona-cards.ts.

export function GradingDiscoverWidget() {
  const { profile } = useAuth();
  const passports = usePassportSummary();

  const cards = featureCardsFor(profile?.use_case ?? null, {
    verifiedEnabled: profile?.verified_enabled ?? false,
    verifiedHandle: profile?.verified_handle ?? null,
    passportCount: passports.data?.count ?? 0,
    latestPassportSlug: passports.data?.latestSlug ?? null,
  });

  if (cards.length === 0) return null;

  // A plain list of links rather than a grid of icon-tile boxes: each row is
  // one thing to try, and the whole row is the link.
  return (
    <ul className="divide-y">
      {cards.map((feature) => (
        <li key={feature.key}>
          <Link
            to={feature.to}
            className="group flex items-start justify-between gap-3 rounded-md py-3 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:px-2"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{feature.title}</span>
              <span className="block text-sm text-muted-foreground">
                {feature.description}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
              {feature.cta}
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
