import { Lock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAutolisterDrafts } from "@/hooks/use-autolister";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import { FLIPDESK_PLANS, type FlipdeskPlanKey } from "@/lib/constants";
import { explainGate } from "@/lib/plan-gates";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC6: AutoLister drafts still waiting on a human.
//
// The count is useAutolisterDrafts(), the same read the cockpit page runs, so
// the two can never disagree about how many are waiting.
//
// THE PLAN GATE IS THE SIDEBAR'S, COPIED DELIBERATELY (US-2872). AutoLister is
// a `requiresFlipdeskFlag` feature, and that class of gate renders
// VISIBLE-BUT-LOCKED rather than hidden: a hidden feature cannot be wanted, and
// the moment of maximum intent is when the seller is standing in the surface
// that would have used it. So a Free or Starter account gets a frame that names
// the plan and says what the feature does, not a missing frame and not a bare
// "Upgrade".

export function FlipdeskAutolisterDraftsWidget() {
  const { data: billing, isLoading: billingLoading } = useBillingSummary();
  const showUpgrade = useUpgradeDialogStore((st) => st.show);
  const plan = (billing?.subscription.plan as FlipdeskPlanKey) ?? "free";
  const entitled = FLIPDESK_PLANS[plan].gateFlags.autolister;
  const gate = explainGate("autolister");

  // Gated off rather than fetched-and-discarded: a locked account has no
  // AutoLister drafts by definition, and a query it can never use is a request
  // per board render for nothing.
  const drafts = useAutolisterDrafts(entitled);

  if (billingLoading) return <StatTileSkeleton label="AutoLister drafts" />;

  if (!entitled && gate) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">
            Included with the {gate.requiredPlanLabel} plan
          </p>
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{gate.what}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mt-1"
          onClick={() =>
            showUpgrade({
              reason: { type: "feature", feature: "AutoLister" },
              currentPlan: plan,
              requiredPlan: gate.requiredPlan,
            })
          }
        >
          See what {gate.requiredPlanLabel} includes
        </Button>
      </div>
    );
  }

  if (drafts.isLoading) return <StatTileSkeleton label="AutoLister drafts" />;
  if (drafts.isError) {
    return (
      <WidgetLoadError
        what="your AutoLister drafts"
        onRetry={() => void drafts.refetch()}
        retrying={drafts.isFetching}
      />
    );
  }

  const rows = drafts.data?.rows ?? [];
  const needsFixing = rows.filter(
    (r) => r.needs_review || (r.aspect_review?.length ?? 0) > 0,
  ).length;

  return (
    <StatTile
      label="Drafts to review"
      icon={<Sparkles className="h-5 w-5" />}
      value={rows.length.toLocaleString()}
      sub={
        rows.length === 0
          ? "Nothing waiting on your read-through"
          : needsFixing > 0
            ? `${needsFixing} flagged for a fix`
            : "Written and priced, waiting on you"
      }
      to="/dashboard/flipdesk/autolister?view=drafts"
    />
  );
}
