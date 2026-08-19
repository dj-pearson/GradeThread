import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /connect/** — client-rendered app shell.
//
// US-9121's consent screen lives at /connect/claude, and a consent screen is
// only ever reached by a COLD LOAD: the seller arrives via a redirect from
// /oauth/authorize carrying the query string the page reads. Without this
// Function that redirect landed on a 404 — the connector's whole approval flow
// dead-ended, and nothing on the eBay or grading side would have shown it.
//
// Not prerendered, deliberately. The page has no static content: with no query
// string it renders "This connection link is incomplete", which is not a thing
// to put in a sitemap. It is registered as a flow page in the PUBLIC_ROUTES
// guard for the same reason.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
