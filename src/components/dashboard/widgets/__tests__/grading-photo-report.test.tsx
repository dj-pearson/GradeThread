// US-3337: the photo report card shows the tip, the per-slot rates, and an
// empty state before the first grade.
// renderToStaticMarkup is the repo's convention (no @testing-library/react).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PhotoReportCardView } from "@/components/dashboard/widgets/grading-photo-report";
import type { PhotoReportCard, PhotoSlotReport } from "@/hooks/use-photo-report-card";

const none = { count: 0, rate: 0 };
function slot(s: PhotoSlotReport["slot"], photos: number, dark: number): PhotoSlotReport {
  return {
    slot: s,
    photos,
    with_problems: dark,
    problem_rate: dark / photos,
    problems: { blur: none, lighting: { count: dark, rate: dark / photos }, framing: none, illegible: none },
  };
}

const view = (card: PhotoReportCard) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PhotoReportCardView card={card} />
    </MemoryRouter>,
  );

describe("PhotoReportCardView", () => {
  it("before any measured photo: the empty state and a way to start", () => {
    const html = view({ grades_counted: 0, photos_measured: 0, slots: [], weakest: null });
    expect(html).toContain("After your first grade");
    expect(html).toContain('href="/dashboard/submissions/new"');
  });

  it("shows the tip for the weakest slot and each slot's rate in words", () => {
    const html = view({
      grades_counted: 4,
      photos_measured: 8,
      slots: [slot("front", 4, 0), slot("back", 4, 3)],
      weakest: { slot: "back", problem: "lighting", rate: 0.75, tip: "Your back photos are often too dark." },
    });
    expect(html).toContain("8 photos across your last 4 grades");
    expect(html).toContain("Your back photos are often too dark.");
    expect(html).toContain("3 of 4 too dark");
    expect(html).toContain("4 ok");
  });

  it("with no weak slot, says so instead of inventing a tip", () => {
    const html = view({ grades_counted: 1, photos_measured: 2, slots: [slot("front", 2, 0)], weakest: null });
    expect(html).toContain("Your photos are in good shape");
    expect(html).toContain("last 1 grade<");
  });
});
