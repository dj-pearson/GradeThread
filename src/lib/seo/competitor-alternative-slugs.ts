// The competitor-alternative SLUGS, and nothing else.
//
// WHY THIS IS ITS OWN FILE. `competitor-alternatives.ts` is a 16 KB editorial
// data set — titles, positioning, per-competitor switch reasons, the honest
// "when to stay" copy. The ROUTER needs none of it. It needs the slugs, to
// register `/reselling/<slug>-alternative` explicitly ahead of the
// `/reselling/:slug` dynamic route that would otherwise swallow them.
//
// Importing the full module from `routes/index.tsx` put the whole data set in
// the EAGER entry chunk, so every visitor to the landing page downloaded the
// prose for pages they were not on. The eager graph is budgeted
// (`scripts/check-bundle-budget.mjs`) and had crossed it; that guard says in so
// many words not to raise the ceiling, because the cause is structural. This is
// one of the structural causes.
//
// DRIFT IS THE THING TO WATCH, since the point of generating routes from the
// data was that the route list, the sitemap and the pages could not disagree.
// That guarantee now rests on a test rather than on a shared array:
// `competitor-alternative-slugs.test.ts` asserts the two lists are equal in
// BOTH directions, so a competitor added to the data set with no slug here
// fails the build rather than 404-ing quietly.

/** Slugs, in the order the routes and the sitemap should list them. */
export const COMPETITOR_ALTERNATIVE_SLUGS = [
  "vendoo",
  "list-perfectly",
  "crosslist",
] as const;

/** The public path for a competitor-alternative page. */
export function alternativePath(slug: string): string {
  return `/reselling/${slug}-alternative`;
}
