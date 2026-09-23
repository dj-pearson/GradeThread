import type { ItemStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

// Optional preflight: blocks moves that don't have prerequisites met.
// Returns null on success, or a reason string to surface in the toast.
export function validateStatusChange(
  item: ItemListRow,
  next: ItemStatus,
): string | null {
  // No-op (same status) — never blocked.
  if (item.status === next) return null;

  // Personal statuses (keeping / wearing) and archived are always allowed —
  // user is making a deliberate "remove from sales pipeline" decision.
  if (next === "keeping" || next === "wearing" || next === "archived") {
    return null;
  }

  // "Grading" is owned by the grade-submission flow, not the board — an item
  // lands here only when it's actually been sent to GradeThread (which also
  // creates the submission + charge). Dragging into it would fake the state.
  if (next === "grading") {
    return "Submit the item for grading from its detail panel — this stage is set automatically.";
  }

  // Hard prereqs per stage. These match the canonical "definition of done"
  // for each step in the FlipDesk PRD (section 3.2).
  if (next === "measured") {
    if (!item.measurements || Object.keys(item.measurements).length === 0) {
      return "Item needs measurements before it can move to Measured.";
    }
  }

  // Same rule the auto-advance uses (workflow.ts earnedStatus): Photographed is
  // earned by has_required_photos, which is a front AND a back photo. Without
  // this a card with zero photos could be dragged here, and batch advance
  // sends Photographed cards straight into paid bulk grading.
  if (next === "photographed" && item.has_required_photos !== true) {
    return "Add a front and back photo before moving to Photographed.";
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

  return null;
}
