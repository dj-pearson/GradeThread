import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// US-2045: /buyer-guarantee/claim is a CLIENT-ROUTED page with no Pages
// Function and no prerendered file, so a direct load fell through
// public/_redirects (/* → /404.html) and hard-404'd.
//
// That is not a theoretical edge case — it was the primary path:
// src/pages/certificate.tsx:1323 links to it with a plain <a href>, i.e. a FULL
// page load, so every buyer following the guarantee link from a certificate hit
// a 404. The <Link to> usages on the marketing page worked in-SPA and 404'd on
// refresh or share, which is exactly the shape that hides a bug from testing.
//
// It also undercut the buyer-dashboard fix that points entitled subscribers
// here: an in-app <Link> reached it, a reload did not.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
