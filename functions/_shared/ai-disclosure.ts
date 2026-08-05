// US-2399: the buyer-facing AI disclosure wording for the Cloudflare Pages
// Functions (the /cert SSR page and the white-label grade widget).
//
// This is a DELIBERATE duplicate of src/lib/ai-disclosure-copy.ts: a Pages
// Function can't import from the Vite `src` tree. Keep the two in lockstep —
// src/test/embed-grade-widget.test.ts asserts they match string-for-string, so
// editing one without the other fails CI.
//
// Why the variant is keyed on the report's `human_reviewed` flag rather than on a
// blanket statement about the product: migration 00312 made review MANDATORY, so
// the certificate is withheld until a super-admin approves the AI grade as-is or
// adjusts it, and "AI-generated" alone would understate what happened. But the
// pre-00312 backfill marked historic rows approved WITHOUT setting
// human_reviewed, so those legacy certificates are genuinely AI-only and must
// keep saying so. Absent/null degrades to the AI-only wording.

import { escape } from "./blog-render";

/** Headline shown above the disclosure body. */
export function aiDisclosureTitle(humanReviewed: boolean): string {
  return humanReviewed
    ? "AI-assisted grade, finalized by a human reviewer"
    : "AI-generated condition estimate — not a professional appraisal or guarantee";
}

/** The disclosure body. Plain text so every surface can style it its own way. */
export function aiDisclosureBody(humanReviewed: boolean): string {
  const provenance = humanReviewed
    ? "A GradeThread reviewer checked this grade before it was published and either approved it as-is or adjusted the scores. The underlying condition assessment is produced by an automated AI system from the seller's photos."
    : "This grade is produced by an automated AI system from the seller's photos.";
  return `${provenance} It is an estimate of condition, not a certified appraisal, authentication, or warranty of value. Always review the photos and item description before purchasing.`;
}

// US-2400: the /cert SSR page's disclosure block, as a pure builder.
//
// It lives here rather than inline in functions/cert/[id].ts for the same reason
// widget.ts exists: [id].ts uses the Cloudflare worker globals (PagesFunction /
// EventContext), which the Vitest `src` tsconfig does not load — so nothing under
// src/test can import it, and the rendered wording was untestable. Extracting the
// block makes the SSR bytes assertable without a worker runtime, and [id].ts
// splices this exact string into its body.

/** The `<aside>` the /cert SSR page renders under the condition report. */
export function aiDisclosureNoticeHtml(humanReviewed: boolean): string {
  return `<aside class="cert-ai-disclosure" style="margin-top:20px;padding:12px 16px;border:1px solid #fcd34d;border-radius:12px;background:#fffbeb;color:#78350f;font-size:13px;line-height:1.55">
    <strong>${escape(aiDisclosureTitle(humanReviewed))}.</strong>
    ${escape(aiDisclosureBody(humanReviewed))}
    <a href="/terms" style="color:#78350f">See our Terms</a> (section 5) for details.
  </aside>`;
}
