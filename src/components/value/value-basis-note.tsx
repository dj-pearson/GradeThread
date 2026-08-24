import { cn } from "@/lib/utils";

// US-2850: one component for "what is this number", everywhere a price appears.
//
// The wording is NOT written here. It arrives from the edge in
// services/edge-functions/src/lib/value-disclosure.ts, because a sentence about
// provenance that lives next to one surface's markup will eventually say
// something a different surface contradicts. This file decides where the line
// sits and how loud it is; the edge decides what it says.
//
// Renders nothing when there is no basis. A value from a payload built before
// this shipped is silent rather than mislabelled.

/** Mirrors ValueBasis in services/edge-functions/src/lib/value-disclosure.ts. */
export interface ValueBasis {
  source: "measured_curve" | "comp_median";
  prices: "active_asking" | "sold_realized";
  sampleSize: number;
  slopeCentsPerPoint: number | null;
  slopeShape: "rises_with_condition" | "flat" | "falls_with_condition" | null;
  measuredAt: string | null;
  headline: string;
  detail: string;
}

interface ValueBasisNoteProps {
  basis: ValueBasis | null | undefined;
  /**
   * "full" prints the headline and the detail. "short" prints the headline
   * alone, for a row in a list where two sentences would bury the price.
   */
  variant?: "full" | "short";
  className?: string;
}

export function ValueBasisNote({ basis, variant = "full", className }: ValueBasisNoteProps) {
  if (!basis) return null;
  return (
    <div className={cn("text-xs leading-relaxed text-muted-foreground", className)}>
      <span className="font-medium text-foreground">{basis.headline}</span>
      {variant === "full" && basis.detail ? <span> {basis.detail}</span> : null}
    </div>
  );
}
