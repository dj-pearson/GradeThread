import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /trust/:handle — opt-in public buyer Trust Score profile (US-1818). Shared
// by link, so it is nearly always a direct load. serveSpaShell sends
// x-robots-tag: noindex, which matches this route's private-by-default intent
// (it is deliberately absent from PUBLIC_ROUTES and the sitemap).
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
