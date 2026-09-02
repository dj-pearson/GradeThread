import { Link } from "react-router";
import { TrendingUp } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  FLIPDESK_PLANS,
  flipdeskPlanForLegacy,
  type PlanKey,
} from "@/lib/constants";
import { Badge } from "@/components/ui/badge";

// US-3075 AC1: the Current Plan card, as a widget.
//
// US-2365: the legacy shim's `gradesPerMonth` was
// FLIPDESK_PLANS.includedStandardGradesPerMonth under an older name, and the
// shim's price branch divided by 100 and mapped 0 to 0. Both are read directly
// here, off the current column where the profile carries one.

export function GradingPlanWidget() {
  const { profile } = useAuth();
  const plan = profile?.plan ?? "free";
  const config =
    FLIPDESK_PLANS[profile?.flipdesk_plan ?? flipdeskPlanForLegacy(plan as PlanKey)];

  return (
    <Link
      to="/dashboard/billing"
      className="block rounded-xl border px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Current plan</span>
        <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="flex items-center gap-2">
        <span className="text-2xl font-bold">{config.name}</span>
        <Badge variant="secondary" className="text-xs">
          {config.priceMonthlyCents === 0
            ? "Free"
            : `${config.priceMonthlyCents / 100}/mo`}
        </Badge>
      </span>
    </Link>
  );
}
