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
