import { serveSpaShell } from "./_shared/spa-shell";
import type { PagesEnv } from "./_shared/blog-render";

// US-2045: /waitlist-pending had no Function and no prerendered file, so it
// hard-404'd on direct load — and src/lib/edge-fetch.ts:137 reaches it via
// `window.location.href`, a FULL navigation. So a gated user was redirected
// straight into a 404 page, with no explanation and nowhere to go.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
