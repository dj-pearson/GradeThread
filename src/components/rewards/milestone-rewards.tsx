import { Check, Gift } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { MilestoneProgress } from "@/hooks/use-rewards";

// US-1857, over the US-1853 grant model: the tangible-reward area.
//
// There is NO CLAIM BUTTON, and that is the design, not an omission. Crossing a
// milestone GRANTS the reward — the engine runs off the back of the action that
// earned it, and XP is never debited for it. A button labelled "Claim" beside an
// automatic grant would invent a step a user can forget to take, and then punish
// them for forgetting. So this is a receipt plus a horizon: what has landed, and
// what the next rung costs.
//
// It renders nothing at all when the ladder is off AND nothing has ever been
// granted. A "rewards" section that is permanently empty teaches people to
// ignore the part of the page where their rewards will appear.

function nf(n: number): string {
  return n.toLocaleString();
}

function grantLine(rewardType: string, value: number, label: string): string {
  if (label) return label;
  if (rewardType === "free_grade_credits") {
    return `${value} free grade${value === 1 ? "" : "s"}`;
  }
  return `${value}% off`;
}

function expiryNote(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "";
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return " · expired";
  return ` · ${days} day${days === 1 ? "" : "s"} left`;
}

export function MilestoneRewards({ milestones }: { milestones: MilestoneProgress }) {
  const { enabled, granted, next } = milestones;
  if (!enabled && granted.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Gift className="h-5 w-5 text-primary" />
          Milestone rewards
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Real rewards for real mileage. They land on your account by themselves — your XP is
          never spent on them.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {granted.length > 0 && (
          <ul className="space-y-2">
            {granted.map((g) => (
              <li key={g.milestone_key} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {grantLine(g.reward_type, g.reward_value, g.label)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {g.granted_at
                      ? `Granted ${new Date(g.granted_at).toLocaleDateString()}`
                      : "Granted"}
                    {expiryNote(g.expires_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {next ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium">Next: {next.label}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {nf(next.xp_remaining)} XP to go
              </p>
            </div>
            <Progress value={next.percent} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              Unlocks at {nf(next.xp_threshold)} XP. Nothing to press — it arrives when you
              cross the line.
            </p>
          </div>
        ) : (
          granted.length > 0 && (
            <p className="text-xs text-muted-foreground">
              You&apos;ve taken every rung on the ladder. New milestones get added over time.
            </p>
          )
        )}

        {!enabled && granted.length > 0 && (
          <p className="text-xs text-muted-foreground">
            New milestone rewards are paused right now. Everything above is yours to keep.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
