import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { disputeCountLabel, DISPUTE_KIND_LABEL } from "@/lib/dispute-kind";

// SUB-04: My Disputes names each row's kind and counts them apart.

describe("dispute kind labels", () => {
  it("counts disputes and appeals separately", () => {
    expect(
      disputeCountLabel([{ kind: "grade" }, { kind: "grade" }, { kind: "authenticity" }]),
    ).toBe("2 disputes, 1 appeal");
    expect(disputeCountLabel([{ kind: "grade" }])).toBe("1 dispute");
    expect(disputeCountLabel([{ kind: "authenticity" }, { kind: "authenticity" }])).toBe(
      "2 appeals",
    );
  });

  it("My Disputes reads in one embedded select and labels each row", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/submissions.tsx"), "utf8");
    expect(src).toContain("grade_reports(submission_id, submissions(title))");
    expect(src).toContain("DISPUTE_KIND_LABEL[d.kind]");
    expect(src).toContain('"Deleted submission"');
    expect(src).not.toContain('?? "Unknown"');
    expect(DISPUTE_KIND_LABEL.authenticity).toBe("Authenticity appeal");
  });
});
