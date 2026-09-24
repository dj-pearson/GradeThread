import { Link } from "react-router";
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

  // Flat: the frame already says "Current plan", so no second title, icon or
  // border here.
  const price =
    config.priceMonthlyCents === 0
      ? "Free"
      : `${new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(config.priceMonthlyCents / 100)}/mo`;

  return (
    <Link
      to="/dashboard/billing"
      className="flex items-center gap-2 rounded-md py-1 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="text-2xl font-bold">{config.name}</span>
      <Badge variant="secondary" className="text-xs">
        {price}
      </Badge>
    </Link>
  );
}
