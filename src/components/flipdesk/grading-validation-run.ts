import type { Run } from "@/lib/latest-run";
import type {
  GradingTier,
  ValidationItem,
  ValidationResult,
} from "@/hooks/use-grading";

// US-3223. GradeThisItemCard has TWO writers of the validation block that sits
// beside the button that charges for a grade: the tier effect, and the inline
// garment picker's save. The effect got a run-scoped flag on 2026-09-09; the
// save did not, and the two race each other.
//
// The interleaving: the seller picks a garment type and presses Save (tier =
// standard). That save writes the row, invalidates items_full and re-validates.
// While it is in flight the seller flips the tier picker to express, whose
// effect run resolves first and paints express's price, credit balance and
// "grades remaining". Then the save's own validate lands and puts STANDARD's
// numbers back, under a picker that says express — and Submit charges express.
//
// Both writers now go through here, so whichever started last owns the block.

export interface ValidationPatch {
  validation: ValidationItem | null;
  planRemaining: number | null;
  includedRemaining: number | null;
  creditBalance: number | null;
  /** The owner account: grades are free, but still counted below. */
  unlimited: boolean;
  includedUsed: number;
  includedCap: number;
}

/**
 * The patch a /validate response should apply, or null when a newer run has
 * taken ownership and this response must be dropped.
 */
export function acceptValidation(
  run: Run,
  res: ValidationResult,
): ValidationPatch | null {
  if (run.superseded) return null;
  return {
    validation: res.items[0] ?? null,
    // grades_remaining is Infinity on an unlimited plan, and the card renders
    // the number directly — null means "don't show a count".
    planRemaining: Number.isFinite(res.user.grades_remaining)
      ? res.user.grades_remaining
      : null,
    includedRemaining: res.user.included_remaining ?? null,
    creditBalance: res.user.credit_balance ?? null,
    // Absent on an edge deployed before the owner count; read as a seller.
    unlimited: res.user.unlimited === true,
    includedUsed: res.user.grades_used_this_month,
    includedCap: res.user.plan_limit,
  };
}

/**
 * What the submit toast says about the allowance, from a /validate made AFTER
 * the charge. Read back rather than computed locally, so the toast shows what
 * the database now holds: a claim that silently failed would show the old
 * count instead of hiding behind arithmetic.
 */
export function allowanceReadback(
  tier: GradingTier,
  res: ValidationResult,
): string {
  const u = res.user;
  if (u.unlimited) {
    return tier === "standard"
      ? `Counted: ${u.grades_used_this_month} of ${u.plan_limit} this month.`
      : "Only Standard grades are counted.";
  }
  const parts: string[] = [];
  if (u.included_remaining != null) {
    parts.push(
      `${u.included_remaining} included grade${u.included_remaining === 1 ? "" : "s"} left`,
    );
  }
  if (u.credit_balance != null) {
    parts.push(`${u.credit_balance} credit${u.credit_balance === 1 ? "" : "s"} left`);
  }
  return parts.length > 0 ? `${parts.join(", ")}.` : "";
}
