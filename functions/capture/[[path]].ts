import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /capture/:token — the phone half of desktop-to-phone photo capture (US-3161).
// The seller opens it by scanning a QR code shown on their desktop, so like
// /t/:code and /claim/:token before it this URL is ONLY ever a cold direct
// load. With no SPA fallback rewrite every scan 404'd, which means the feature
// has never worked outside a dev server.
//
// Third time for this exact shape. The router is not the routing table here:
// a route can exist in src/routes/index.tsx, render perfectly under `npm run
// dev`, and still be unreachable in production, because Cloudflare Pages only
// serves what public/_routes.json includes and what has a function behind it.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
