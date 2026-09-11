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
import {
  appShellSecurityHeaders,
  inlineBootstrapHash,
} from "./app-shell-headers";

/**
 * What these routes serve when the shell itself could not be fetched (US-3384).
 *
 * 503 + Retry-After, never a 200 over somebody else's error body. Every route
 * using serveSpaShell is noindex and no-cache already, so the only reader is a
 * person, and a person is better served by "try again shortly" than by an asset
 * server's error page wearing a green status code. `no-store` keeps it out of
 * every cache, including the browser's.
 */
function shellUnavailable(reason: string): Response {
  return new Response("Temporarily unavailable - please retry shortly.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "60",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      // Diagnosable from `curl -I` without putting the reason in the body.
      "x-gt-shell": reason,
    },
  });
}

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
    return shellUnavailable("binding missing");
  }

  // US-3384: this call used to be trusted unconditionally. A non-2xx shell got
  // the robots regex applied (matching nothing), the bootstrap hash computed
  // over it, and was served as a 200 with the full app security headers — so a
  // broken deploy reached a shopper on /login or /dashboard as a successful
  // page. The identical call in blog-render.ts renderHydratableSsrResponse
  // checks `.ok` and catches; this is that shape.
  //
  // There is no fallback body to serve here: the shell IS the app, and there is
  // nothing else to render sixteen route groups with. So the honest answer is a
  // 503, which also tells a health check the truth.
  let shell: Response;
  try {
    shell = await env.ASSETS.fetch(`${origin}/`);
  } catch (e) {
    console.warn("[spa-shell] asset fetch threw:", e);
    return shellUnavailable("fetch threw");
  }
  if (!shell.ok) {
    console.warn(`[spa-shell] asset fetch returned ${shell.status} for ${origin}/`);
    return shellUnavailable(`status ${shell.status}`);
  }

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
  let html: string;
  try {
    html = await shell.text();
  } catch (e) {
    console.warn("[spa-shell] shell body unreadable:", e);
    return shellUnavailable("body unreadable");
  }
  html = html.replace(
    /<meta\s+name=["']robots["'][^>]*>/i,
    '<meta name="robots" content="noindex, nofollow">',
  );

  // US-2330: Cloudflare `_headers` does not apply to Pages Function responses,
  // so this Response is the ONLY place the authenticated surface can get its
  // security headers. Before this, /login and /dashboard shipped with none.
  //
  // The hash is computed from the HTML fetched above rather than hardcoded: the
  // one in public/_headers is rewritten at build time from the built bootstrap,
  // and a second copy here would go stale the first time that script changed.
  const scriptHash = await inlineBootstrapHash(html);

  return new Response(html, {
    status: 200,
    headers: {
      ...appShellSecurityHeaders(scriptHash),
      "content-type": shell.headers.get("content-type") ?? "text/html; charset=utf-8",
      // App shells are user-specific once mounted; don't let a shared cache pin
      // a stale build's HTML to an authed route.
      "cache-control": "no-cache",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
