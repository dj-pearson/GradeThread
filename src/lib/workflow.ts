import type { ItemStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

// Ordered prep + sale pipeline. Side-track statuses (keeping/wearing/
// archived/returned) sit outside this rank and are only set manually.
const STAGE_RANK: Record<string, number> = {
  sourced: 0,
  acquired: 1,
  cataloged: 2,
  measured: 3,
  photographed: 4,
  grading: 5,
  graded: 6,
  comped: 7,
  drafted: 8,
  listed: 9,
  sold: 10,
  shipped: 11,
  completed: 12,
};

// Statuses that auto-advance can manage. Anything else (sold/shipped/
// completed/returned/keeping/wearing/archived) is set by explicit action.
const PREP_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
]);

export function rankOf(status: ItemStatus): number {
  return STAGE_RANK[status] ?? -1;
}

// The facts that drive auto-advance, derived from item state.
export interface WorkFacts {
  hasMeasurements: boolean;
  hasRequiredPhotos: boolean;
  hasTargetPrice: boolean;
  hasDraftListing: boolean;
}

export function factsOf(item: ItemListRow): WorkFacts {
  return {
    hasMeasurements:
      !!item.measurements && Object.keys(item.measurements).length > 0,
    hasRequiredPhotos: item.has_required_photos === true,
    hasTargetPrice: item.target_price != null,
    hasDraftListing: item.listing_id != null,
  };
}

// The furthest prep stage the item has *earned* through completed work.
// Grading is optional, so it is never gated on.
export function earnedStatus(facts: WorkFacts): ItemStatus {
  if (facts.hasDraftListing) return "drafted";
  if (facts.hasTargetPrice) return "comped";
  if (facts.hasRequiredPhotos) return "photographed";
  if (facts.hasMeasurements) return "measured";
  return "cataloged";
}

// Resolve the status to persist. Auto-advances forward from completed work,
// never regresses, and lets a manual pick of a non-prep status win outright.
export function resolveStatus(
  current: ItemStatus,
  selected: ItemStatus,
  facts: WorkFacts,
): ItemStatus {
  // Manual pick of a side-track / sale status — the user's choice wins.
  if (!PREP_STATUSES.has(selected)) return selected;

  const earned = earnedStatus(facts);
  // Take the furthest of where it is, where the user put it, and what the
  // completed work has earned. Forward-only.
  const candidates: ItemStatus[] = [current, selected, earned];
  return candidates.reduce((best, s) =>
    rankOf(s) > rankOf(best) ? s : best,
  );
}

export type NextActionKind =
  | "measure"
  | "photograph"
  | "grade"
  | "grading"
  | "review_grade"
  | "comp"
  | "draft"
  | "list"
  | "sell"
  | "ship"
  | "complete"
  | "relist"
  | "done"
  | "none";

export interface NextAction {
  kind: NextActionKind;
  label: string;
  tone: "todo" | "ready" | "done" | "muted";
}

// What the reseller should do next on this item.
export function nextAction(item: ItemListRow): NextAction {
  const s = item.status;

  // Side tracks — nothing actionable in the selling pipeline.
  if (s === "keeping" || s === "wearing" || s === "archived") {
    return { kind: "none", label: "—", tone: "muted" };
  }
  if (s === "returned") {
    return { kind: "relist", label: "Relist or write off", tone: "todo" };
  }
  if (s === "completed") {
    return { kind: "done", label: "Done", tone: "done" };
  }
  if (s === "shipped") {
    return { kind: "complete", label: "Mark complete", tone: "ready" };
  }
  if (s === "sold") {
    return { kind: "ship", label: "Ship it", tone: "ready" };
  }
  if (s === "listed") {
    return { kind: "sell", label: "Awaiting sale", tone: "muted" };
  }

  // Grading bridge. An item submitted to GradeThread waits in "grading"
  // until the AI lands; a freshly-graded item gets a "grade ready" nudge
  // before it continues down the prep flow. (Grading itself stays optional —
  // earnedStatus/resolveStatus never gate on it.)
  if (s === "grading") {
    return { kind: "grading", label: "Grading…", tone: "muted" };
  }
  if (s === "graded") {
    return { kind: "review_grade", label: "Grade ready", tone: "ready" };
  }

  // Prep phase — drive by completed work, in order.
  const facts = factsOf(item);
  if (!facts.hasMeasurements) {
    return { kind: "measure", label: "Add measurements", tone: "todo" };
  }
  if (!facts.hasRequiredPhotos) {
    return { kind: "photograph", label: "Add photos", tone: "todo" };
  }
  if (!facts.hasTargetPrice) {
    // Photos are in but there's no price yet. Grading is the natural next
    // step here (the pipeline frames it as "Send to GradeThread"), so nudge
    // it once — unless the item is already graded, then go straight to comp.
    if (item.grade_value == null) {
      return { kind: "grade", label: "Grade it", tone: "todo" };
    }
    return { kind: "comp", label: "Comp & price", tone: "todo" };
  }
  if (!facts.hasDraftListing) {
    return { kind: "draft", label: "Draft listing", tone: "todo" };
  }
  return { kind: "list", label: "Ready to list", tone: "ready" };
}
