import { Link } from "react-router";
import { Lock, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import type { BuyerGateFlags } from "@/lib/constants";

// US-1802: shared buyer feature placeholder. The buyer shell ships before the
// individual feature epics (US-1805…1844), so every suite route renders this
// until its real surface lands. It is entitlement-aware: a buyer whose plan does
// NOT unlock the feature sees an upgrade prompt; a buyer who is entitled sees a
// "coming soon" so the shell never dead-ends.
export function BuyerPlaceholderPage({
  title,
  requiresFlag,
  description,
  action,
}: {
  title: string;
  requiresFlag?: keyof BuyerGateFlags;
  description?: string;
  /**
   * US-2042: a real thing an ENTITLED buyer can do right now, when the full
   * surface has not shipped but the capability exists elsewhere. Without this,
   * a placeholder tells someone who PAID for a feature that it is "coming
   * soon" — which is indistinguishable from not having bought it.
   */
  action?: { to: string; label: string };
}) {
  const ent = useBuyerEntitlements();
  const locked = requiresFlag ? !ent.has(requiresFlag) : false;

  return (
    <div className="mx-auto max-w-2xl">
      <Card className="flex flex-col items-center gap-4 p-10 text-center">
        {locked ? (
          <>
            <Lock className="h-8 w-8 text-muted-foreground" />
            <h1 className="text-xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">
              {description ??
                `${title} is part of a higher buyer plan.`}{" "}
              Upgrade to unlock it.
            </p>
            <Link
              to={`/buyer/billing?upgrade=${requiresFlag ?? ""}`}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              See plans
            </Link>
          </>
        ) : (
          <>
            <Sparkles className="h-8 w-8 text-primary" />
            <h1 className="text-xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">
              {description ?? `${title} is coming soon to your buyer dashboard.`}
            </p>
            {action && (
              <>
                {/* US-2042: the capability is LIVE even though this dashboard
                    view is not — send the buyer to it rather than dead-ending
                    them on the feature their plan includes. */}
                <Link
                  to={action.to}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {action.label}
                </Link>
                <p className="text-xs text-muted-foreground">
                  The full dashboard view is on its way — this does everything
                  you need in the meantime.
                </p>
              </>
            )}
            <Link to="/buyer" className="text-sm font-medium text-primary hover:underline">
              ← Back to buyer home
            </Link>
          </>
        )}
      </Card>
    </div>
  );
}
