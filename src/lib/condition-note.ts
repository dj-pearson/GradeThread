import { MARKETPLACE_SPECS, type MarketplacePlatform } from "@/lib/marketplace-specs";
import type { DefectFound, GradeReportRow } from "@/types/database";

// SUB-15: the condition text a seller pastes into a listing on any
// marketplace, built from the grade they already have.
//
// Sellers listing outside FlipDesk retyped the condition by hand, and the
// buyer-facing write-up (buyer_writeup, US-759) was never shown on the
// submission page at all. This puts it, the grade, the worst flaws and the
// certificate link in one block, sized to each marketplace.

export type ConditionNoteReport = Pick<
  GradeReportRow,
  "buyer_writeup" | "ai_summary" | "overall_score" | "grade_tier" | "defects_found"
>;

/**
 * eBay has a dedicated condition-description field, capped at 1000
 * characters by the Inventory API. Every other marketplace takes condition
 * wording in the description, so the note gets at most half of that field
 * (the listing needs the rest), and never more than 1000.
 */
export const EBAY_CONDITION_DESCRIPTION_MAX = 1000;
const NOTE_CEILING = 1000;

export function conditionNoteLimit(platform: MarketplacePlatform): number {
  if (platform === "ebay") return EBAY_CONDITION_DESCRIPTION_MAX;
  const description = MARKETPLACE_SPECS[platform].descriptionMaxLength;
  return description ? Math.min(NOTE_CEILING, Math.floor(description / 2)) : NOTE_CEILING;
}

const SEVERITY_RANK: Record<DefectFound["severity"], number> = {
  major: 0,
  moderate: 1,
  minor: 2,
};

function flawLine(defects: readonly DefectFound[] | null | undefined, max = 3): string {
  const top = [...(defects ?? [])]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2))
    .slice(0, max);
  if (top.length === 0) return "No flaws noted.";
  const items = top.map((d) =>
    d.location ? `${d.defect} (${d.location}, ${d.severity})` : `${d.defect} (${d.severity})`,
  );
  return `Noted flaws: ${items.join("; ")}.`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, Math.max(0, max));
  // Cut on a word boundary where there is one close by.
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}...`;
}

/**
 * The note for one marketplace. The grade line and the certificate link are
 * never trimmed: they are what makes the note checkable. The write-up gives
 * way first, then the flaw line.
 */
export function buildConditionNote(
  report: ConditionNoteReport,
  platform: MarketplacePlatform,
  certificateUrl: string,
): string {
  const limit = conditionNoteLimit(platform);
  const grade = `Condition grade: ${report.overall_score.toFixed(1)}/10 (${report.grade_tier}), independently graded by GradeThread.`;
  const verify = `Verify the grade: ${certificateUrl}`;
  const flaws = flawLine(report.defects_found);
  const body = (report.buyer_writeup ?? report.ai_summary ?? "").trim();

  const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");
  const fixed = join([grade, flaws, verify]);
  if (fixed.length > limit) {
    // Not even the flaws fit: keep what can be checked.
    return clip(join([grade, verify]), limit);
  }
  if (!body) return fixed;
  const room = limit - fixed.length - 2; // the "\n\n" before the body
  if (room < 40) return fixed;
  return join([clip(body, room), grade, flaws, verify]);
}
