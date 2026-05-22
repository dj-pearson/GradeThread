import type { ItemFullRow, ItemStatus } from "@/types/database";

// Statuses participating in the main selling pipeline (the Kanban view).
const PIPELINE_ORDER: ItemStatus[] = [
  "sourced",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
  "listed",
  "sold",
  "shipped",
  "completed",
  "returned",
];

// Optional preflight: blocks moves that don't have prerequisites met.
// Returns null on success, or a reason string to surface in the toast.
export function validateStatusChange(
  item: ItemFullRow,
  next: ItemStatus,
): string | null {
  // No-op (same status) — never blocked.
  if (item.status === next) return null;

  // Personal statuses (keeping / wearing) and archived are always allowed —
  // user is making a deliberate "remove from sales pipeline" decision.
  if (next === "keeping" || next === "wearing" || next === "archived") {
    return null;
  }

  // Hard prereqs per stage. These match the canonical "definition of done"
  // for each step in the FlipDesk PRD (section 3.2).
  if (next === "measured") {
    if (!item.measurements || Object.keys(item.measurements).length === 0) {
      return "Item needs measurements before it can move to Measured.";
    }
  }

  if (next === "listed") {
    // To go live: either we have a comp/target price or at least an entered
    // list price. Without one, the user probably hasn't drafted yet.
    if (
      item.target_price == null &&
      item.list_price == null
    ) {
      return "Add a target or list price before marking the item Listed.";
    }
  }

  if (next === "shipped") {
    // To ship: there has to be a sale.
    if (item.sale_price == null) {
      return "Record a sale before marking the item Shipped.";
    }
  }

  // Skip-ahead rule: allow forward jumps within the order, but flag big
  // jumps (3+ stages ahead) so the user confirms they didn't drop on the
  // wrong column.
  const fromIdx = PIPELINE_ORDER.indexOf(item.status);
  const toIdx = PIPELINE_ORDER.indexOf(next);
  if (fromIdx >= 0 && toIdx >= 0 && toIdx - fromIdx >= 4) {
    // Soft warning — return null to allow, but the UI can choose to confirm.
    // We allow it; the user is explicitly dragging, so trust the choice.
    return null;
  }

  return null;
}
