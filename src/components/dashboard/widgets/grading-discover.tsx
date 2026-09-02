import { useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePassportSummary } from "@/hooks/use-passport-summary";
import { featureCardsFor } from "@/lib/dashboard-persona-cards";
import { Button } from "@/components/ui/button";

// US-1118's Discover cards, moved onto the widget board by US-3075 AC1. The
// list itself lives in src/lib/dashboard-persona-cards.ts.

export function GradingDiscoverWidget() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const passports = usePassportSummary();

  const cards = featureCardsFor(profile?.use_case ?? null, {
    verifiedEnabled: profile?.verified_enabled ?? false,
    verifiedHandle: profile?.verified_handle ?? null,
    passportCount: passports.data?.count ?? 0,
    latestPassportSlug: passports.data?.latestSlug ?? null,
  });

  if (cards.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((feature) => {
        const Icon = feature.icon;
        return (
          <div
            key={feature.key}
            className="flex flex-col gap-3 rounded-xl border px-4 py-4"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              <p className="text-sm font-medium">{feature.title}</p>
            </div>
            <p className="flex-1 text-xs text-muted-foreground">
              {feature.description}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => navigate(feature.to)}
            >
              {feature.cta}
              <ArrowRight className="ml-1.5 h-3 w-3" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
