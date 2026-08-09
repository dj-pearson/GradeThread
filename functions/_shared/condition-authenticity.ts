// US-2225 AC3: keep a CONDITION grade from reading as an AUTHENTICITY verdict
// on the surfaces a Cloudflare Pages Function renders.
//
// A handbag is the one item where the two land on the same page. Every
// authentication tell pack GradeThread holds is for a bag brand — louisvuitton,
// coach, gucci — so the authenticity add-on and the condition grade converge on
// exactly the items where a buyer is most likely to conflate them. "9.2" beside
// a Louis Vuitton logo reads as a verdict on the logo unless the page says it
// is not one, and on a four-figure resale that misreading is a liability rather
// than a UX regret.
//
// A DELIBERATE duplicate of the constant in src/lib/rubrics.ts, for the same
// reason ai-disclosure.ts duplicates src/lib/ai-disclosure-copy.ts: a Pages
// Function cannot import from the Vite `src` tree. The two are pinned
// string-for-string by src/test/cert-condition-authenticity.test.ts, so editing
// one without the other fails CI.
//
// The list is keyed on RUBRIC, not on brand. Keying it on brand would mean
// every new luxury brand needs a code change to be covered, and the failure
// mode of forgetting one is silent — the certificate simply omits the line for
// the item that needed it most.

import { escape } from "./blog-render";

/** Rubrics whose items collide with the authenticity add-on. */
export const AUTHENTICITY_ADJACENT_RUBRIC_KEYS: readonly string[] = ["bags"];

/**
 * The fixed separation line. Never model-authored — like the AI disclosure, the
 * grader must not be able to soften or omit it.
 */
export const CONDITION_NOT_AUTHENTICITY_DISCLOSURE =
  "This is a condition grade only. It is not an opinion on whether this item is authentic.";

/** Does a certificate on this rubric need the separation shown? */
export function needsAuthenticitySeparation(
  rubricKey: string | null | undefined,
): boolean {
  return !!rubricKey && AUTHENTICITY_ADJACENT_RUBRIC_KEYS.includes(rubricKey);
}

/**
 * The separation block, or "" when the rubric does not need one.
 *
 * Returns markup rather than a string the caller assembles, so the ADJACENCY is
 * part of the shared thing: this belongs immediately beside the score it
 * qualifies. A separation rendered in a page footer is a disclaimer nobody
 * reaches, which is indistinguishable from not having one.
 */
export function conditionAuthenticityNoticeHtml(
  rubricKey: string | null | undefined,
): string {
  if (!needsAuthenticitySeparation(rubricKey)) return "";
  return `<p class="cert-condition-only">${escape(CONDITION_NOT_AUTHENTICITY_DISCLOSURE)}</p>`;
}
