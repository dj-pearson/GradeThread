// US-3329 part 2: the Cleanliness factor, told honestly.
//
// Two things a certificate now says about the fifth factor, and one rule that
// keeps them apart from the grade:
//
//   seller_statements   what the SELLER states (smoke-free home, pet-free home).
//                       Their claim, shown as theirs. Never graded, never in a
//                       prompt, never moves a score.
//   cleanliness_visible false when every analyzed photo marked odor_cleanliness
//                       unassessable, so the composite wrote a neutral
//                       placeholder rather than a finding.
//
// The Postgres view public_grade_reports computes cleanliness_visible the same
// way (00787); cleanliness-statements_test.ts pins the two against the same
// cases so the SPA certificate and the SSR one cannot disagree.
//
// Pure. No supabase, no env.

export const SELLER_STATEMENTS = ["smoke_free", "pet_free"] as const;
export type SellerStatement = (typeof SELLER_STATEMENTS)[number];

/** Keep only known statements, deduped, in the canonical order. */
export function normalizeSellerStatements(raw: unknown): SellerStatement[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(",")
    : [];
  const wanted = new Set(
    values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase()),
  );
  return SELLER_STATEMENTS.filter((s) => wanted.has(s));
}

/** From a multipart submit: repeated fields or one comma-separated value. */
export function parseSellerStatements(formData: FormData): SellerStatement[] {
  return normalizeSellerStatements(
    formData.getAll("seller_statements").flatMap((v) =>
      typeof v === "string" ? v.split(",") : []
    ),
  );
}

/**
 * False only when there were analyses and EVERY one listed odor_cleanliness
 * as unassessable. No analyses, or a shape this does not recognise, reads as
 * visible: the certificate claims nothing it cannot back.
 */
export function cleanlinessVisible(perImageAnalysis: unknown): boolean {
  if (!Array.isArray(perImageAnalysis) || perImageAnalysis.length === 0) return true;
  return !perImageAnalysis.every((a) => {
    const u = (a as { unassessable_factors?: unknown } | null)?.unassessable_factors;
    return Array.isArray(u) && u.includes("odor_cleanliness");
  });
}
