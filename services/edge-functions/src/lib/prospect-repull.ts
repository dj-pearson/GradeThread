// Correcting a wrong identification without paying to re-identify — US-2923.
//
// THE CASE THIS EXISTS FOR. US-2758 measured eBay visual search naming an exact
// style from a silhouette with no tag in frame, and also returning five
// confident Lululemon tanks for a garment carrying no brand mark at all. The
// seller holding the garment can see which happened. Before this, they could
// not say so: /prospect took photos and nothing else, so the only way to correct
// "Lululemon Commission Pant" to "Lululemon ABC Pant" was to re-shoot and hope.
//
// WHAT A RE-PULL IS. The seller supplies the identification, so the route skips
// identification AND skips grading, re-resolves the eBay category from the
// corrected words, and runs the same value + sell-through + decision pipeline it
// always ran. It costs ZERO metered AI actions. The photos did not change, so
// the condition grade did not change either — it is carried across from the run
// that produced it.
//
// WHY AN UNUSABLE OVERRIDE IS AN ERROR AND NOT A FALLTHROUGH. The tempting
// shape is "if the override is blank, just do a normal identify". That turns a
// typo into a silent double charge: the client sends no photos on a re-pull, so
// the normal path would either 400 about a missing photo (confusing) or, if
// photos were attached, spend two AI actions the seller did not ask for. An
// override that is present and unusable is refused by name.
//
// Nothing here calls anything. It decides, and is tested by reading its answer.

/** Longer than any real garment query; past this eBay is being sent noise. */
export const MAX_OVERRIDE_TITLE_CHARS = 200;

/** The grading scale's real endpoints — see CLAUDE.md "Grading System". */
const GRADE_MIN = 1.0;
const GRADE_MAX = 10.0;

export interface ProspectOverride {
  kind: "override";
  /** The corrected query, trimmed. Never empty. */
  title: string;
  brand: string | null;
  /**
   * The grade carried across from the run being corrected, or null.
   *
   * It is a HINT, not an authority: all it does is pick which eBay condition
   * bucket the comps are filtered to, for this caller's own screen. It is
   * range-checked anyway, because a value off the scale would silently select
   * "New with tags" comps for a used garment.
   */
  gradeValue: number | null;
  gradeTier: string | null;
  /** Always false. Named so the cost claim is a value a test can assert. */
  needsIdentify: false;
  needsGrade: false;
}

export type ProspectOverrideResult =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | ProspectOverride;

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Read the re-pull inputs off a /prospect body.
 *
 * `none` means this is an ordinary prospect and nothing below it changes.
 */
export function parseProspectOverride(body: {
  titleOverride?: unknown;
  brandOverride?: unknown;
  gradeValue?: unknown;
  gradeTier?: unknown;
}): ProspectOverrideResult {
  const raw = body.titleOverride;
  if (raw === undefined || raw === null) return { kind: "none" };

  if (typeof raw !== "string") {
    return { kind: "invalid", error: "titleOverride must be text." };
  }
  const title = raw.trim();
  if (title.length === 0) {
    return { kind: "invalid", error: "Enter a title to search for." };
  }
  if (title.length > MAX_OVERRIDE_TITLE_CHARS) {
    return {
      kind: "invalid",
      error: `Keep the title under ${MAX_OVERRIDE_TITLE_CHARS} characters.`,
    };
  }

  // Dropped rather than clamped. Clamping 11.0 to 10.0 would manufacture a
  // New-With-Tags reading nobody made; null prices at the default used bucket,
  // which is what an ungraded prospect has always done.
  const g = body.gradeValue;
  const gradeValue = typeof g === "number" && Number.isFinite(g) &&
      g >= GRADE_MIN && g <= GRADE_MAX
    ? g
    : null;

  return {
    kind: "override",
    title,
    brand: cleanString(body.brandOverride),
    gradeValue,
    gradeTier: cleanString(body.gradeTier),
    needsIdentify: false,
    needsGrade: false,
  };
}
