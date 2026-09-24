import { describe, expect, it } from "vitest";
import {
  buildGuaranteeText,
  qualifiesForGuarantee,
  type GuaranteeCandidate,
} from "@/lib/condition-guarantee";

// A15: guarantee text only for an item that qualifies, carrying its own
// certificate, and never promising a refund policy the app does not know.

const CERT = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c";
const item = (over: Partial<GuaranteeCandidate> = {}): GuaranteeCandidate => ({
  id: "i1",
  title: "Carhartt Detroit jacket",
  grade_value: 9.0,
  certificate_url: `https://gradethread.com/cert/${CERT}`,
  ...over,
});

describe("buildGuaranteeText", () => {
  it("contains that item's grade and certificate URL", () => {
    const t = buildGuaranteeText(item(), { sold: 40, keptRate: 0.975 })!;
    expect(t).toContain("graded 9.0 out of 10");
    expect(t).toContain(`/cert/${CERT}`);
    expect(t).toContain("Across my 40 sales graded 8.5 or higher, 98% shipped with no return.");
  });

  it("refuses an item graded below 8.5", () => {
    expect(buildGuaranteeText(item({ grade_value: 8.4 }), null)).toBeNull();
    expect(buildGuaranteeText(item({ grade_value: 6 }), null)).toBeNull();
    expect(qualifiesForGuarantee(item({ grade_value: 8.5 }))).toBe(true);
  });

  it("refuses an item with no certificate, or a link that is not one", () => {
    expect(buildGuaranteeText(item({ certificate_url: null }), null)).toBeNull();
    expect(buildGuaranteeText(item({ certificate_url: "https://example.com/x" }), null)).toBeNull();
  });

  it("refuses an ungraded item", () => {
    expect(buildGuaranteeText(item({ grade_value: null }), null)).toBeNull();
  });

  it("points to the seller's return policy instead of promising a refund", () => {
    const t = buildGuaranteeText(item(), null)!;
    expect(t).toContain("see my return policy");
    expect(t).not.toMatch(/full refund/i);
    // No record passed, no track-record sentence.
    expect(t).not.toContain("shipped with no return");
  });
});
