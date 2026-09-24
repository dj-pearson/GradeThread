import type { NextActionKind } from "@/lib/workflow";

// INV-14: where the Next column's button takes the seller for each step.
// `publish` opens the page's own publish dialog; null means there is nothing
// to click (waiting on a buyer, on grading, or nothing left to do).
export type NextActionTarget = { to: string } | { publish: true } | null;

export function nextActionTarget(kind: NextActionKind, itemId: string): NextActionTarget {
  const item = `/dashboard/flipdesk/items/${encodeURIComponent(itemId)}`;
  switch (kind) {
    case "measure":
    case "photograph":
    case "grade":
    case "review_grade":
      return { to: item };
    case "comp":
    case "draft":
      return { to: `${item}/draft` };
    case "list":
    case "relist":
      return { publish: true };
    default:
      return null;
  }
}
