import { Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

// US-2851: the highest price to pay, or plainly nothing.
//
// THE ABSENT CASE IS THE FEATURE. A seller standing in an aisle wants a number,
// and the temptation is to give them one from whatever comps happen to be
// around. A ceiling built on an unadjusted comp median is a spending limit
// derived from a price that was never adjusted for the condition of the thing
// in their hand, which is the exact error the whole condition-priced bet exists
// to fix. So when there is no measured curve this says so, in one line, and
// leaves the seller with the judgement they already had.

/** Mirrors SourcingCeiling in services/edge-functions/src/lib/scout-decision.ts. */
export interface SourcingCeiling {
  maxPriceCents: number | null;
  targetRoi: number;
  netResaleCents: number | null;
  /**
   * US-3193: postage + supplies + grading, subtracted before the target was
   * applied. Optional so a response from an edge that predates the field still
   * renders; absent reads as zero and the clause is simply omitted.
   */
  costsCents?: number;
  absentReason: "no_measured_curve" | "insufficient_comps" | "no_headroom" | null;
}

const ABSENT_COPY: Record<NonNullable<SourcingCeiling["absentReason"]>, string> = {
  // Said in the seller's terms, not ours. "No publishable curve" means nothing
  // to somebody holding a jacket.
  no_measured_curve:
    "We have not read enough listings of this item to set a max price yet, so this one is your call.",
  insufficient_comps:
    "Too few comparable listings to set a max price on this one.",
  no_headroom:
    "After fees there is nothing left on this item at any price worth paying.",
};

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function SourcingCeilingNote({
  ceiling,
  className,
}: {
  ceiling: SourcingCeiling | null | undefined;
  className?: string;
}) {
  if (!ceiling) return null;

  if (ceiling.maxPriceCents == null) {
    return (
      <div className={cn("text-xs leading-relaxed text-muted-foreground", className)}>
        {ABSENT_COPY[ceiling.absentReason ?? "insufficient_comps"]}
      </div>
    );
  }

  const targetPct = Math.round(ceiling.targetRoi * 100);
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
      <div className="text-sm leading-relaxed">
        <span className="font-medium">
          Don&rsquo;t pay more than{" "}
          <span className="tabular-nums">{dollars(ceiling.maxPriceCents)}</span>
        </span>
        <span className="text-muted-foreground">
          {" "}
          to clear your {targetPct}% target. It resells around{" "}
          <span className="tabular-nums">{dollars(ceiling.netResaleCents)}</span> after
          fees at the condition it is in
          {/* US-3193: the ceiling used to price postage, packaging and grading
              at zero, so it sat higher than any price that actually cleared the
              target. Now that they are subtracted, the sentence has to say so —
              a number that moved down with no explanation reads as a bug. */}
          {(ceiling.costsCents ?? 0) > 0 ? (
            <>
              , less{" "}
              <span className="tabular-nums">{dollars(ceiling.costsCents ?? 0)}</span> to
              post, pack and grade it
            </>
          ) : null}
          .
        </span>
      </div>
    </div>
  );
}
