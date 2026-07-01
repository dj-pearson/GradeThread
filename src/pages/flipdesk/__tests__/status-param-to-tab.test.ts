import { describe, it, expect } from "vitest";
import { statusParamToTab } from "@/pages/flipdesk/inventory-tabs";
import { FLIPDESK_PIPELINE } from "@/lib/constants";

// US-1429: the Overview pipeline grid, stat cards, and Kanban "+N more" links
// navigate to the inventory table with `?status=<stage>`. The table maps that
// param onto a tab via statusParamToTab. These assert each emitted link lands
// on the intended filtered view rather than the default tab.

describe("statusParamToTab (US-1429 stage-link routing)", () => {
  it("maps the Overview stat-card statuses to their tabs", () => {
    // Total items → All; Listed this week → Active; Sold this week → Sold;
    // Net profit (completed sales) → Sold.
    expect(statusParamToTab("all")).toBe("all");
    expect(statusParamToTab("listed")).toBe("active");
    expect(statusParamToTab("sold")).toBe("sold");
    expect(statusParamToTab("completed")).toBe("sold");
  });

  it("maps every pre-listed prep stage to the To List tab", () => {
    for (const s of [
      "sourced",
      "acquired",
      "cataloged",
      "measured",
      "photographed",
      "grading",
      "graded",
      "comped",
    ]) {
      expect(statusParamToTab(s)).toBe("to_list");
    }
  });

  it("maps the terminal/listed stages to their own tabs", () => {
    expect(statusParamToTab("drafted")).toBe("drafts");
    expect(statusParamToTab("listed")).toBe("active");
    expect(statusParamToTab("shipped")).toBe("shipped");
    expect(statusParamToTab("returned")).toBe("returned");
    // US-1483: archived items now have their own tab.
    expect(statusParamToTab("archived")).toBe("archived");
  });

  it("resolves EVERY Overview/Kanban pipeline-grid link to a real tab", () => {
    // The pipeline grid + Kanban "+N more" emit ?status=<step.status> for each
    // FLIPDESK_PIPELINE step — none may fall through to the default.
    for (const step of FLIPDESK_PIPELINE) {
      expect(
        statusParamToTab(step.status),
        `pipeline status "${step.status}" must map to a tab`,
      ).not.toBeNull();
    }
  });

  it("returns null for an unknown or missing status (caller defaults)", () => {
    expect(statusParamToTab(null)).toBeNull();
    expect(statusParamToTab(undefined)).toBeNull();
    expect(statusParamToTab("")).toBeNull();
    expect(statusParamToTab("not-a-status")).toBeNull();
  });
});
