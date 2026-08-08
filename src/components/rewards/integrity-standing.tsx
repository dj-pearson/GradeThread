import { BadgeCheck, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { IntegrityStanding } from "@/hooks/use-rewards";

// US-1912 AC1: the seller's Grade Integrity standing, stated so they can account
// for it.
//
// This is deliberately NOT a score with a number and nothing else. A reputation
// figure a seller cannot explain is one they cannot act on, and a public one they
// cannot explain is one they will read as arbitrary. So the card always answers
// three questions in order: where you stand, why, and what would move it.
//
// The other half of the honesty is the pre-floor state. Below the confirmed-
// outcome floor there is no tier at all — not a low tier, not a bad score, and
// nothing buyers can see. Rendering "building history" as a rank would turn the
// anti-gaming floor into exactly the early-bad-score it exists to prevent.

interface IntegrityStandingCardProps {
  integrity: IntegrityStanding;
}

export function IntegrityStandingCard({ integrity }: IntegrityStandingCardProps) {
  const building = !integrity.displayable;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Grade Integrity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={
              building
                ? "rounded-full bg-muted px-3 py-1 text-sm font-semibold text-muted-foreground"
                : "inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1 text-sm font-bold text-white"
            }
          >
            {!building && <BadgeCheck className="h-4 w-4" />}
            {integrity.label}
          </span>
          <span className="text-sm text-muted-foreground">
            {building
              ? "Not shown to buyers yet."
              : "Shown on your verified profile and on every certificate you publish."}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">
          This is the one number here that buyers, not you, decide. It comes from
          what they told us after delivery: did the item match the grade.
        </p>

        {integrity.reasons.length > 0 && (
          <ul className="space-y-1 text-sm">
            {integrity.reasons.map((reason) => (
              <li key={reason} className="text-foreground">
                {reason}
              </li>
            ))}
          </ul>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Confirmed</dt>
            <dd className="font-semibold">{integrity.confirmed_count}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Upheld disputes</dt>
            <dd className="font-semibold">{integrity.disputed_count}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Photo coverage</dt>
            <dd className="font-semibold">
              {integrity.avg_coverage_pct == null
                ? "—"
                : `${Math.round(integrity.avg_coverage_pct)}%`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Items graded</dt>
            <dd className="font-semibold">
              {integrity.graded_volume.toLocaleString()}
            </dd>
          </div>
        </dl>

        {/* A dispute nobody has ruled on yet is counted in neither column above.
            Saying so is the point: a seller who sees a dispute filed and no
            movement here should know that is deliberate, not a delay. */}
        <p className="text-xs text-muted-foreground">
          A dispute only counts once one of our reviewers has ruled on it. Until
          then it affects nothing.
        </p>

        {integrity.next_tier && integrity.next_tier_gaps.length > 0 && (
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-sm font-medium">
              To reach {integrity.next_tier}
            </p>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
              {integrity.next_tier_gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
