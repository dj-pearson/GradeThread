import { serveSpaShell } from "./_shared/spa-shell";
import type { PagesEnv } from "./_shared/blog-render";

// /connect-extension — client-rendered app shell (US-1873). Opened from the
// browser extension's popup / onboarding to mint an extension token and hand it
// to the install. Served as a SPA shell (like /accept-invite) so a hard load /
// refresh returns 200 instead of the _redirects 404 fallback.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
