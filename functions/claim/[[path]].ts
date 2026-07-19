import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /claim/:token — passport claim links, which arrive by email or on a printed
// tag and are therefore ONLY ever opened as a direct load. The route was
// documented in src/routes/index.tsx as "a pure SPA route (no SSR Pages
// Function)", but a pure SPA route is unreachable here: there is no SPA
// fallback rewrite, so every claim link 404'd.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
