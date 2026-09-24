import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACE_SPECS, type MarketplacePlatform } from "@/lib/marketplace-specs";
import {
  buildConditionNote,
  conditionNoteLimit,
  type ConditionNoteReport,
} from "@/lib/condition-note";
import { formatCountdown } from "@/lib/countdown";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { ConditionNoteCard } = await import("@/components/grade/condition-note-card");

// SUB-15: the condition text for a listing, and the held-grade countdown.

const CERT = "https://gradethread.com/cert/55555555-5555-5555-5555-555555555555";
const PLATFORMS = Object.keys(MARKETPLACE_SPECS) as MarketplacePlatform[];

const REPORT: ConditionNoteReport = {
  buyer_writeup: "Clean, well kept jacket with light wear at the cuffs. ".repeat(80),
  ai_summary: "Summary.",
  overall_score: 8.5,
  grade_tier: "Excellent",
  defects_found: [
    { defect: "pilling", severity: "minor", location: "sleeve" },
    { defect: "small hole", severity: "major", location: "back hem" },
    { defect: "fading", severity: "moderate", location: "collar" },
    { defect: "loose thread", severity: "minor", location: "pocket" },
  ],
};

describe("buildConditionNote", () => {
  for (const p of PLATFORMS) {
    it(`${p}: stays within its limit and keeps the certificate link`, () => {
      const note = buildConditionNote(REPORT, p, CERT);
      expect(note.length).toBeLessThanOrEqual(conditionNoteLimit(p));
      expect(note).toContain(CERT);
      expect(note).toContain("8.5/10 (Excellent)");
    });
  }

  it("lists the worst flaws first, three at most", () => {
    const note = buildConditionNote(REPORT, "ebay", CERT);
    expect(note).toContain(
      "Noted flaws: small hole (back hem, major); fading (collar, moderate); pilling (sleeve, minor).",
    );
    expect(note).not.toContain("loose thread");
  });

  it("uses the buyer write-up, falling back to the AI summary", () => {
    expect(buildConditionNote({ ...REPORT, buyer_writeup: "Short." }, "ebay", CERT)).toMatch(/^Short\./);
    expect(buildConditionNote({ ...REPORT, buyer_writeup: null }, "ebay", CERT)).toMatch(/^Summary\./);
  });

  it("says so when there are no flaws", () => {
    expect(buildConditionNote({ ...REPORT, defects_found: [] }, "depop", CERT)).toContain(
      "No flaws noted.",
    );
  });
});

describe("the Copy button", () => {
  it("puts the note on the clipboard", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = document.createElement("div");
    const root = createRoot(el);
    act(() =>
      root.render(
        <ConditionNoteCard report={REPORT} certificateId="55555555-5555-5555-5555-555555555555" />,
      ),
    );
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Copy")!;
    await act(async () => {
      button.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(copied).toBe(el.querySelector("textarea")!.value);
    expect(copied).toContain("/cert/55555555-5555-5555-5555-555555555555");
    act(() => root.unmount());
  });
});

describe("formatCountdown", () => {
  it("counts down in hours and minutes", () => {
    expect(formatCountdown(3 * 3_600_000 + 12 * 60_000)).toBe("in 3 h 12 min");
    expect(formatCountdown(12 * 60_000)).toBe("in 12 min");
    expect(formatCountdown(2 * 3_600_000)).toBe("in 2 h");
    expect(formatCountdown(30_000)).toBe("any minute now");
    expect(formatCountdown(-5_000)).toBe("any minute now");
  });
});
