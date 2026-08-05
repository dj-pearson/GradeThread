// US-2399: the buyer-facing AI disclosure wording, as plain strings.
//
// FTC guidance on AI claims is about the disclosure travelling WITH the claim and
// describing what actually happened — so every public surface that shows a grade
// (the certificate page, the standalone embed page, and the server-rendered
// partner widget) must say the same thing, and what it says must be true OF THAT
// GRADE.
//
// Two variants, keyed on the report's `human_reviewed` flag rather than on a
// blanket statement about the product:
//
//   human_reviewed = true  → a reviewer finalized it. Migration 00312 made review
//     MANDATORY: the pipeline writes review_status='pending' and WITHHOLDS the
//     certificate until a super-admin approves the AI grade as-is or adjusts it
//     (grading-pipeline.ts sets human_reviewed=true on that finalize). So for
//     every grade certified after 00312, "a human finalized this" is the accurate
//     description and "AI-generated" alone would understate the process.
//
//   human_reviewed = false → the pre-00312 backfill marked historic rows
//     review_status='approved' WITHOUT touching human_reviewed, so these legacy
//     certificates are genuinely AI-only. They must keep saying so.
//
// Lives in lib/ (not next to the component) so it stays a pure string module: the
// Cloudflare Pages Function at functions/embed/grade/widget.ts can't import from
// the Vite `src` tree, so it DUPLICATES these two functions. Keep the two in
// lockstep — src/test/embed-grade-widget.test.ts asserts they match exactly.

/** Headline shown above the disclosure body. */
export function aiDisclosureTitle(humanReviewed: boolean): string {
  return humanReviewed
    ? "AI-assisted grade, finalized by a human reviewer"
    : "AI-generated condition estimate — not a professional appraisal or guarantee";
}

/** The disclosure body. Plain text so the worker widget can reuse the wording. */
export function aiDisclosureBody(humanReviewed: boolean): string {
  const provenance = humanReviewed
    ? "A GradeThread reviewer checked this grade before it was published and either approved it as-is or adjusted the scores. The underlying condition assessment is produced by an automated AI system from the seller's photos."
    : "This grade is produced by an automated AI system from the seller's photos.";
  return `${provenance} It is an estimate of condition, not a certified appraisal, authentication, or warranty of value. Always review the photos and item description before purchasing.`;
}
