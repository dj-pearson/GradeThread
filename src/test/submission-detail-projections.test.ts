import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRADE_REPORT_OWNER_SELECT,
  SUBMISSION_IMAGE_COLUMNS,
  LINKED_ITEM_COLUMNS,
} from "@/lib/submission-detail-columns";

// SUB-02: the seller page reads only what it renders. The grade_reports row
// carries anti-fraud signals (image_authenticity tells, forensic_analysis,
// detailed_notes) that must never reach the browser from this page.

const DETAIL = "src/pages/submission-detail.tsx";
const src = () => readFileSync(resolve(process.cwd(), DETAIL), "utf8");

describe("submission detail projections (SUB-02)", () => {
  it("no select('*') is left on the page", () => {
    expect(src()).not.toMatch(/\.select\(\s*["']\*["']\s*\)/);
  });

  it("the grade_reports projection leaves out internal signals", () => {
    for (const col of [
      "image_authenticity",
      "detailed_notes",
      "forensic_analysis",
      "reviewed_by",
      "content_signature",
    ]) {
      expect(GRADE_REPORT_OWNER_SELECT.split(/,\s*/)).not.toContain(col);
    }
    expect(GRADE_REPORT_OWNER_SELECT).toContain("defects_found");
    expect(GRADE_REPORT_OWNER_SELECT).toContain("buyer_writeup");
    expect(GRADE_REPORT_OWNER_SELECT).toContain("review_due_at");
    expect(GRADE_REPORT_OWNER_SELECT).toContain("certificate_id");
  });

  it("photo and linked-item reads skip EXIF, originals and cost basis", () => {
    expect(SUBMISSION_IMAGE_COLUMNS).not.toMatch(/exif|original_storage_path/);
    expect(LINKED_ITEM_COLUMNS).not.toMatch(/cost|search_vec/);
  });

  it("the page never renders the internal notes (SUB-03)", () => {
    expect(src()).not.toContain("detailed_notes");
    expect(src()).toContain("<DetectedIssues defects={gradeReport.defects_found} />");
  });
});

describe("the admin alert is sent by the dispute route (SUB-05)", () => {
  it("the page no longer fires a separate /dispute-filed request", () => {
    // That request looked the dispute up under the member's own id and 404'd
    // silently for every member-filed dispute.
    expect(src()).not.toContain("/api/notifications/dispute-filed");
  });
});
