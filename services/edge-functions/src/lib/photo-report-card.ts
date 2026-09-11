// US-3337: the seller's photo report card.
//
// Every grade stores a per-photo quality read in per_image_analysis (blur,
// lighting, framing, and label legibility; PerImageQuality in ai-grading.ts),
// and the seller never saw any of it. This turns the last N grades into a
// problem rate per photo slot and one concrete tip for the weakest slot.
//
// Pure: the route loads the rows, tenant-scoped, and passes them in. Only
// counts leave the server; per_image_analysis itself never does.
//
// Rules:
//   - A photo with no quality object was not measured. It is left out of the
//     denominator instead of being counted as good or bad.
//   - Legibility only means anything on a label, so it is counted there only.
//   - A tip needs at least MIN_PHOTOS_FOR_TIP measured photos in the slot, so
//     one bad photo does not become "your front photos are often blurry".

export const PHOTO_REPORT_DEFAULT_GRADES = 20;
export const PHOTO_REPORT_MAX_GRADES = 50;
export const MIN_PHOTOS_FOR_TIP = 3;

export type PhotoProblem = "blur" | "lighting" | "framing" | "illegible";
export const PHOTO_PROBLEMS: readonly PhotoProblem[] = ["blur", "lighting", "framing", "illegible"];

export type PhotoSlot = "front" | "back" | "label" | "detail" | "defect" | "measurement";
const SLOT_ORDER: readonly PhotoSlot[] = ["front", "back", "label", "detail", "defect", "measurement"];

export const SLOT_LABEL: Record<PhotoSlot, string> = {
  front: "front",
  back: "back",
  label: "label",
  detail: "close-up",
  defect: "flaw",
  measurement: "measurement",
};

/** The slot an image_type belongs to, or null for types the card ignores. */
export function slotFor(imageType: unknown): PhotoSlot | null {
  const t = typeof imageType === "string" ? imageType.toLowerCase().trim() : "";
  if (t === "front" || t === "back" || t === "defect") return t;
  if (t === "label" || t.startsWith("label_")) return "label";
  if (t === "detail" || t.startsWith("detail_")) return "detail";
  if (t.startsWith("measurement")) return "measurement";
  return null;
}

/** Which problems one photo's quality read shows. Null when not measured. */
export function problemsIn(slot: PhotoSlot, quality: unknown): PhotoProblem[] | null {
  if (!quality || typeof quality !== "object") return null;
  const q = quality as Record<string, unknown>;
  const out: PhotoProblem[] = [];
  if (q.blur === "mild" || q.blur === "severe") out.push("blur");
  if (q.lighting === "dim" || q.lighting === "dark") out.push("lighting");
  if (q.framing === "partial") out.push("framing");
  if (slot === "label" && q.legible === false) out.push("illegible");
  return out;
}

export interface SlotReport {
  slot: PhotoSlot;
  photos: number;
  /** Photos with at least one problem. */
  with_problems: number;
  problem_rate: number;
  /** Per problem: how many photos showed it, and the rate. */
  problems: Record<PhotoProblem, { count: number; rate: number }>;
}

export interface PhotoReportCard {
  grades_counted: number;
  photos_measured: number;
  slots: SlotReport[];
  weakest: { slot: PhotoSlot; problem: PhotoProblem; rate: number; tip: string } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function tipFor(slot: PhotoSlot, problem: PhotoProblem): string {
  const s = SLOT_LABEL[slot];
  switch (problem) {
    case "blur":
      return `Your ${s} photos are often blurry. Rest your elbows on something steady, tap the screen on the fabric to focus, and wait a second before you take the shot.`;
    case "lighting":
      return `Your ${s} photos are often too dark. Shoot by a window in daylight and turn off the overhead light, so the fabric shows its true color and texture.`;
    case "framing":
      return slot === "label"
        ? "Your label photos often cut off part of the tag. Get the whole tag in the frame, including the care and fiber text, not just the brand name."
        : `Your ${s} photos often cut off part of the garment. Step back until the whole area fits with a little space on every side.`;
    case "illegible":
      return "Your label photos are often hard to read. Move close enough that the care text fills most of the photo, and tap to focus on the words.";
  }
}

/**
 * Build the card from the seller's grade rows (newest first, already scoped to
 * the seller). `per_image_analysis` is read defensively: anything that is not
 * an array of objects contributes nothing.
 */
export function buildPhotoReportCard(
  rows: ReadonlyArray<{ per_image_analysis: unknown }>,
): PhotoReportCard {
  const counts = new Map<PhotoSlot, { photos: number; withProblems: number; by: Record<PhotoProblem, number> }>();
  let measured = 0;
  for (const row of rows) {
    const images = Array.isArray(row.per_image_analysis) ? row.per_image_analysis : [];
    for (const img of images) {
      if (!img || typeof img !== "object") continue;
      const rec = img as Record<string, unknown>;
      const slot = slotFor(rec.image_type);
      if (!slot) continue;
      const problems = problemsIn(slot, rec.quality);
      if (problems === null) continue;
      measured++;
      const c = counts.get(slot) ??
        { photos: 0, withProblems: 0, by: { blur: 0, lighting: 0, framing: 0, illegible: 0 } };
      c.photos++;
      if (problems.length > 0) c.withProblems++;
      for (const p of problems) c.by[p]++;
      counts.set(slot, c);
    }
  }

  const slots: SlotReport[] = SLOT_ORDER.filter((s) => counts.has(s)).map((slot) => {
    const c = counts.get(slot)!;
    const problems = Object.fromEntries(
      PHOTO_PROBLEMS.map((p) => [p, { count: c.by[p], rate: round2(c.by[p] / c.photos) }]),
    ) as Record<PhotoProblem, { count: number; rate: number }>;
    return {
      slot,
      photos: c.photos,
      with_problems: c.withProblems,
      problem_rate: round2(c.withProblems / c.photos),
      problems,
    };
  });

  // The weakest slot: the highest problem rate among slots with enough photos
  // to mean something; ties go to the slot with more photos, then slot order.
  let weakest: PhotoReportCard["weakest"] = null;
  const eligible = slots
    .filter((s) => s.photos >= MIN_PHOTOS_FOR_TIP && s.with_problems > 0)
    .sort((a, b) => b.problem_rate - a.problem_rate || b.photos - a.photos);
  const worst = eligible[0];
  if (worst) {
    const problem = PHOTO_PROBLEMS
      .filter((p) => worst.problems[p].count > 0)
      .sort((a, b) => worst.problems[b].count - worst.problems[a].count)[0]!;
    weakest = {
      slot: worst.slot,
      problem,
      rate: worst.problems[problem].rate,
      tip: tipFor(worst.slot, problem),
    };
  }

  return { grades_counted: rows.length, photos_measured: measured, slots, weakest };
}

/** Parse ?limit= into a bounded grade count. */
export function parseReportLimit(raw: string | undefined | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return PHOTO_REPORT_DEFAULT_GRADES;
  return Math.min(n, PHOTO_REPORT_MAX_GRADES);
}
