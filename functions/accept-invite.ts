import { serveSpaShell } from "./_shared/spa-shell";
import type { PagesEnv } from "./_shared/blog-render";

// /accept-invite — client-rendered app shell (US-422 fix).
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
