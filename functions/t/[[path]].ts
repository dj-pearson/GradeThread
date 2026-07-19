import { serveSpaShell } from "../_shared/spa-shell";
import type { PagesEnv } from "../_shared/blog-render";

// /t/:code — physical-tag QR scan landing (US-1096). A scanned QR code is by
// definition a cold direct load, so with no SPA fallback this surface was
// entirely non-functional: every scan 404'd.
export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) =>
  serveSpaShell(request, env);
