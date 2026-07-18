// US-422 fix: serve the SPA shell for client-rendered app routes.
//
// The old approach rewrote app namespaces to /index.html with a 200 in
// _redirects, but Cloudflare Pages canonicalizes an /index.html rewrite into a
// 308 → /, which broke hard-loads / refreshes of /dashboard, /login, /admin,
// etc. (deep paths fell through to the /* → /404.html 404 catch-all). Pages
// Functions run BEFORE _redirects, so a Function that returns the shell with an
// explicit 200 fixes it while keeping the original URL in the address bar and
// preserving real 404s for genuinely unknown URLs.

import type { PagesEnv } from "./blog-render";

/**
 * Returns the SPA shell (dist/index.html) with HTTP 200 so the React app boots
 * and client-side routing renders the requested path. Fetches "/" through the
 * static-asset binding (which bypasses Functions, so there's no loop) rather
 * than "/index.html" (which Cloudflare 308-redirects to "/").
 */
export async function serveSpaShell(
  request: Request,
  env: PagesEnv,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  // ASSETS is always bound at runtime; guard only to satisfy the optional type.
  if (!env.ASSETS) {
    return new Response("Service unavailable", { status: 503 });
  }
  const shell = await env.ASSETS.fetch(`${origin}/`);

  // US-2045: KEEP THESE APP ROUTES OUT OF THE INDEX.
  //
  // "/" is the PRERENDERED landing page, not a blank shell, so every route
  // using this helper served crawlers a byte-identical copy of the homepage.
  // Live, /login and /signup returned `<title>GradeThread - The Standard…`,
  // `robots: index, follow`, the full hero <h1>, and duplicate WebSite /
  // SoftwareApplication / FAQPage JSON-LD — three URLs claiming to be the
  // homepage, two of them showing users an auth form. WebSite in particular is
  // meant to be singular per site. The canonical inherited from the homepage
  // probably made Google consolidate them, but that mitigation was accidental,
  // and it did not stop the duplicate structured data.
  //
  // ⚠ Note on approach: an earlier draft of this tried to strip the prerendered
  // <head> using the `prerender:head:start/end` markers. Those markers exist in
  // the SOURCE index.html but are CONSUMED by scripts/prerender.mjs — dist/
  // has none — so that surgery would have matched nothing and silently done
  // nothing. Verified against the built file rather than assumed.
  //
  // So: the X-Robots-Tag HEADER is the real mechanism. It is authoritative for
  // every major crawler, outranks any meta tag, and cannot be defeated by a
  // template change. The meta rewrite below is a secondary signal for tooling
  // that only reads HTML.
  let html = await shell.text();
  html = html.replace(
    /<meta\s+name=["']robots["'][^>]*>/i,
    '<meta name="robots" content="noindex, nofollow">',
  );

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": shell.headers.get("content-type") ?? "text/html; charset=utf-8",
      // App shells are user-specific once mounted; don't let a shared cache pin
      // a stale build's HTML to an authed route.
      "cache-control": "no-cache",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
