import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

// A seller who had folded the FlipDesk section shut opened an item's draft
// page and saw seven sidebar rows and no Inventory. The draft page matches no
// nav row, so nothing forced the section open. Any page under
// /dashboard/flipdesk now counts as being inside the section.

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => true }),
}));
vi.mock("@/hooks/use-billing-summary", () => ({
  useBillingSummary: () => ({ data: { subscription: { plan: "business" } } }),
}));
vi.mock("@/hooks/use-saved-views", () => ({
  useSavedViews: () => ({ data: [] }),
}));
vi.mock("@/components/dashboard/sidebar-usage-widget", () => ({
  SidebarUsageWidget: () => null,
}));
vi.mock("@/components/flipdesk/upload-progress-pill", () => ({
  UploadProgressPill: () => null,
}));

import { Sidebar } from "@/components/dashboard/sidebar";

const COLLAPSE_KEY = "gt-sidebar-collapsed";

const INVENTORY_LINK = 'href="/dashboard/flipdesk/inventory"';

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("a folded section stays open while you are inside it", () => {
  beforeEach(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ FlipDesk: true }));
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("opens FlipDesk on an item page that no nav row matches", () => {
    const html = renderAt("/dashboard/flipdesk/items/45a47c5b-ea58-44ff-86c9-79d648baf48f/draft");
    expect(html).toContain(INVENTORY_LINK);
  });

  it("still honours the fold outside FlipDesk", () => {
    const html = renderAt("/dashboard/submissions");
    // Guards the guard: without this, a fold that never hid anything would
    // make the first case pass for the wrong reason.
    expect(html).toContain(">Submissions<");
    expect(html).not.toContain(INVENTORY_LINK);
  });

  it("does not treat a lookalike path as inside the section", () => {
    expect(renderAt("/dashboard/flipdesk-archive")).not.toContain(INVENTORY_LINK);
  });
});
