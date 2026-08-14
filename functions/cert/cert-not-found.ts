// US-1945 AC2: the DISTINCT, cert-branded 404 the /cert/:id Pages Function
// serves when the public certificate lookup returns nothing. Kept in its own
// module (importing only PagesEnv + notFoundResponse from _shared) so it
// type-checks under BOTH the Functions tsconfig and the FRONTEND tsconfig — the
// AC2 regression test (src/test/cert-ssr.test.ts) runs under the frontend
// config, and the cert Function itself uses Cloudflare-only types.
//
// Why it matters: previously every dynamic SSR surface reused a blog-specific
// 404 ("That post doesn't exist… Back to the blog"), so a genuine-but-missing
// certificate was byte-identical to a random 404 — a buyer could not tell a
// real certificate from a forgery. This page is cert-branded and distinct.

import { notFoundResponse, type PagesEnv } from "../_shared/blog-render";

export function certNotFoundResponse(env: PagesEnv): Response {
  return notFoundResponse(env, {
    title: "Certificate not found — GradeThread",
    heading: "Certificate not found",
    message:
      "This grade certificate could not be found or verified. It may have been " +
      "removed, or the link may be incorrect. " +
      '<a href="/verified">Browse verified sellers &rarr;</a>',
    canonicalPath: "/verified",
  });
}

/**
 * US-2569: the REVISED certificate page.
 *
 * A regrade retires the old certificate, and until now that made its URL answer
 * the branded 404 above — which is the wrong answer twice over. It tells a buyer
 * holding a hangtag that the number they were told to trust is worthless, and it
 * deindexes a URL that is still the correct entry point for that garment.
 *
 * This says what actually happened and where the current grade is. 200, not 404
 * or 301: the page has real content (the revision history), and a redirect would
 * silently swap the certificate under a buyer who is trying to check a specific
 * number.
 */
export function certRevisedResponse(
  env: PagesEnv,
  revision: {
    message: string;
    current_certificate_id: string | null;
    current_certificate_number: string | null;
  },
): Response {
  const link = revision.current_certificate_id
    ? `<a href="/cert/${encodeURIComponent(revision.current_certificate_id)}">` +
      `View the current grade${
        revision.current_certificate_number
          ? ` (${escapeHtml(revision.current_certificate_number)})`
          : ""
      } &rarr;</a>`
    : '<a href="/verify">Check another certificate &rarr;</a>';

  return notFoundResponse(env, {
    title: "Certificate revised — GradeThread",
    heading: "This certificate was revised",
    message: `${escapeHtml(revision.message)} ${link}`,
    canonicalPath: revision.current_certificate_id
      ? `/cert/${revision.current_certificate_id}`
      : "/verify",
    status: 200,
    // Indexable: the canonical points at the CURRENT certificate, so a crawler
    // that already has this URL follows the revision forward instead of dropping
    // a link that is still the right entry point for this garment.
    noindex: false,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
