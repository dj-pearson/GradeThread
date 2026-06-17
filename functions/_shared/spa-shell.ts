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
  // Re-wrap with an explicit 200 and the shell's content-type, dropping any
  // asset cache/redirect headers that shouldn't apply to an authed app route.
  return new Response(shell.body, {
    status: 200,
    headers: {
      "content-type": shell.headers.get("content-type") ?? "text/html; charset=utf-8",
      // App shells are user-specific once mounted; don't let a shared cache pin
      // a stale build's HTML to an authed route.
      "cache-control": "no-cache",
    },
  });
}
