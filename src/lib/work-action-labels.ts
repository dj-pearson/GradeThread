// Worth My Time: the plain name of each kind of job (WMT-12).
//
// One table, read by the plan rows and by the session runner, so the same
// job is never "Price it" in one place and "price_research" in the other.

export const ACTION_LABELS: Record<string, string> = {
  measure: "Measure",
  photograph: "Photograph",
  review_grade: "Review the grade",
  price_research: "Price it",
  draft_review: "Check the draft",
  publish: "Publish",
  pack_ship: "Pack and ship",
};

/** The label, or the raw key when a new action has no words yet. */
export function actionLabel(action: string | null | undefined): string {
  if (!action) return "";
  return ACTION_LABELS[action] ?? action;
}
