// US-1429: shared inventory-tab identity + the status→tab routing used by the
// triage table (listings.tsx) and asserted in unit tests. Kept in its own module
// (not inside the heavy listings.tsx component) so importing the mapping for a
// test doesn't drag the whole page module graph into coverage.

export type TabId =
  | "all"
  | "to_list"
  | "drafts"
  | "active"
  | "sold"
  | "shipped"
  | "returned";

// The Overview pipeline grid, stat cards, and Kanban "+N more" links navigate to
// the inventory table with `?status=<stage>` (an item stage or a sale state), but
// the table keys its view off `?tab=`. Map a `status` param onto the tab that
// actually surfaces those items so those links land on the intended filtered
// view instead of the default tab. Returns null for an unrecognized value so the
// caller can fall back to the default.
export function statusParamToTab(status: string | null | undefined): TabId | null {
  if (!status) return null;
  switch (status) {
    case "all":
      return "all";
    case "drafted":
      return "drafts";
    case "listed":
      return "active";
    // A recorded sale ("sold" item status / "completed" sale state) lives in Sold.
    case "sold":
    case "completed":
      return "sold";
    case "shipped":
      return "shipped";
    case "returned":
      return "returned";
    // Every pre-listed prep stage is surfaced together under To List.
    case "sourced":
    case "acquired":
    case "cataloged":
    case "measured":
    case "photographed":
    case "grading":
    case "graded":
    case "comped":
      return "to_list";
    // Archived items have no dedicated tab — All is the only view that shows them.
    case "archived":
      return "all";
    default:
      return null;
  }
}
