// US-3329: the Cleanliness factor, told honestly on the web.
//
// Mirrors services/edge-functions/src/lib/cleanliness-visibility.ts and the
// public_grade_reports.cleanliness_visible column (00787). The three are held
// together by the shared cases in src/test/cleanliness.test.ts and
// services/edge-functions/src/tests/cleanliness-statements_test.ts.

export const SELLER_STATEMENT_OPTIONS = [
  { key: "smoke_free", label: "Smoke-free home" },
  { key: "pet_free", label: "Pet-free home" },
] as const;

export type SellerStatementKey = (typeof SELLER_STATEMENT_OPTIONS)[number]["key"];

/** Display labels for the known statements, in canonical order; unknowns dropped. */
export function sellerStatementLabels(raw: readonly string[] | null | undefined): string[] {
  const wanted = new Set(raw ?? []);
  return SELLER_STATEMENT_OPTIONS.filter((o) => wanted.has(o.key)).map((o) => o.label);
}

/**
 * False only when there were analyses and EVERY one listed odor_cleanliness as
 * unassessable, i.e. the score is a neutral placeholder rather than a finding.
 */
export function cleanlinessVisible(perImageAnalysis: unknown): boolean {
  if (!Array.isArray(perImageAnalysis) || perImageAnalysis.length === 0) return true;
  return !perImageAnalysis.every((a) => {
    const u = (a as { unassessable_factors?: unknown } | null)?.unassessable_factors;
    return Array.isArray(u) && u.includes("odor_cleanliness");
  });
}
