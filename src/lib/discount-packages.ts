// US-3299: the list of things a sale can be aimed at.
//
// One place, so the admin checkbox grid, the live preview and the display
// surfaces all agree on what a "package" is. Prices come from the live plan
// config where one exists (FlipDesk plans are operator-editable) and from the
// compiled constants otherwise.

import {
  ACTION_CREDIT_PACKS,
  BUYER_PLANS,
  CREDIT_PACKS,
  FLIPDESK_PLANS,
  GRADETHREAD_TIERS,
  type FlipdeskPlanKey,
} from "@/lib/constants";
import type { DiscountInterval, DiscountTarget, DiscountTargetKind } from "@/lib/discounts";
import type { PlansByKey } from "@/hooks/use-pricing-plans";

export interface DiscountPackage {
  kind: DiscountTargetKind;
  key: string;
  interval?: DiscountInterval;
  /** "Starter (monthly)" */
  label: string;
  priceCents: number;
}

export interface DiscountPackageGroup {
  kind: DiscountTargetKind;
  label: string;
  packages: DiscountPackage[];
}

const FLIPDESK_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];
const BUYER_ORDER = ["free", "guard", "connoisseur"] as const;
const INTERVALS: DiscountInterval[] = ["monthly", "yearly"];

/**
 * Every package, grouped for the admin grid.
 *
 * `plans` is the live pricing_plans config when the caller has it (the admin page
 * does); FLIPDESK_PLANS is the fallback so the grid still renders while that
 * query is in flight.
 *
 * ZERO-PRICE PACKAGES ARE INCLUDED. The free tiers cannot be discounted (owner
 * decision 2026-09-09, enforced in resolveDiscount) but they are still shown, so
 * an operator ticking "everything" can see the whole catalogue rather than
 * wondering which rows are missing and why.
 */
export function discountPackageGroups(plans?: PlansByKey): DiscountPackageGroup[] {
  const flipdesk = plans ?? FLIPDESK_PLANS;

  return [
    {
      kind: "flipdesk_plan",
      label: "FlipDesk plans",
      packages: FLIPDESK_ORDER.flatMap((key) =>
        INTERVALS.map((interval) => ({
          kind: "flipdesk_plan" as const,
          key,
          interval,
          label: `${flipdesk[key].name} (${interval})`,
          priceCents: interval === "yearly"
            ? flipdesk[key].priceYearlyCents
            : flipdesk[key].priceMonthlyCents,
        }))
      ),
    },
    {
      kind: "buyer_plan",
      label: "Buyer plans",
      packages: BUYER_ORDER.flatMap((key) =>
        INTERVALS.map((interval) => ({
          kind: "buyer_plan" as const,
          key,
          interval,
          label: `${BUYER_PLANS[key].name} (${interval})`,
          priceCents: interval === "yearly"
            ? BUYER_PLANS[key].priceYearlyCents
            : BUYER_PLANS[key].priceMonthlyCents,
        }))
      ),
    },
    {
      kind: "grade_tier",
      label: "Grading tiers",
      packages: (["standard", "premium", "express"] as const).map((key) => ({
        kind: "grade_tier" as const,
        key,
        label: GRADETHREAD_TIERS[key].label,
        priceCents: GRADETHREAD_TIERS[key].priceCents,
      })),
    },
    {
      kind: "credit_pack",
      label: "Grade credit packs",
      packages: CREDIT_PACKS.map((p) => ({
        kind: "credit_pack" as const,
        key: String(p.credits),
        label: `${p.credits} grade credits`,
        priceCents: p.priceCents,
      })),
    },
    {
      kind: "action_pack",
      label: "Action credit packs",
      packages: ACTION_CREDIT_PACKS.map((p) => ({
        kind: "action_pack" as const,
        key: p.key,
        label: `${p.credits} action credits`,
        priceCents: p.priceCents,
      })),
    },
  ];
}

/** Stable identity for a package, used as the checkbox key and the dedupe key. */
export function packageSignature(t: DiscountTarget | DiscountPackage): string {
  return `${t.kind}|${t.key}|${t.interval ?? ""}`;
}

/** A saved campaign's targets as a set of signatures, for ticking the grid. */
export function targetSignatures(targets: DiscountTarget[]): Set<string> {
  const out = new Set<string>();
  for (const t of targets) {
    if (t.interval) {
      out.add(packageSignature(t));
      continue;
    }
    // A stored target with no interval covers both, so tick both boxes. Saving
    // then writes the two explicit entries back, which resolves identically and
    // means the grid is never showing something different from what is stored.
    out.add(packageSignature({ ...t, interval: "monthly" }));
    out.add(packageSignature({ ...t, interval: "yearly" }));
    out.add(packageSignature(t));
  }
  return out;
}
