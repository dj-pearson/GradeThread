import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /buyer and /buyer/** — the authenticated buyer portal (portfolio, billing,
// alerts, settings, rewards, onboarding, demand, guarantee).
//
// Without this, only in-SPA navigation worked: a hard load, refresh or
// bookmark of any /buyer/* URL fell through to `/* -> /404.html 404` in
// _redirects, because this deployment has NO SPA fallback rewrite (see the
// comment block at the end of public/_redirects). Same fix as /dashboard
// (US-422).
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
