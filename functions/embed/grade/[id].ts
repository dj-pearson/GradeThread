// US-1936: white-label grade embed as an injectable script widget.
//
// The US-596 embed was documented as "rendered inside a partner's <iframe>", but
// the zone ships X-Frame-Options: DENY + CSP frame-ancestors 'none' globally
// (anti-clickjacking, public/_headers) and Cloudflare Pages _headers JOINS
// duplicate header values rather than letting a per-path rule override them — so
// a same-origin iframe can never be framed cross-site without weakening the whole
// app's clickjacking posture, AND frame-ancestors can't express the open,
// per-partner allowlist a white-label embed needs. The team already hit exactly
// this for the cert trust badge (functions/embed/cert/[id].ts) and solved it with
// a script widget: a tiny <script> injects the card straight into the host DOM,
// immune to framing restrictions and renderable on any site the partner controls.
//
// This is the richer counterpart to that badge — it injects the full branded
// grade card (score, tier, 5 weighted factors, partner branding), built by the
// pure helpers in ./widget.ts (which are also unit-tested). All dynamic values
// are validated + HTML-escaped server-side and baked into the returned JS as a
// JSON string, so the host page can't be XSS'd through the embed and no
// client-side data fetch is needed.
//
// Guard (privacy/US-268): data comes from the anonymous
// /api/content/public/certificates/:id endpoint, which hard-filters to certified
// (public, non-flagged) reports only — a private/uncertified cert 404s there and
// yields a no-op script here, so nothing renders. Only the same public-safe
// fields the /cert/:id SSR already exposes are shown.
//
// Route note: the dynamic `[id]` segment also matches the legacy standalone SPA
// page at /embed/grade/:id (no `.js`). We only serve the widget for a `.js`
// request and delegate everything else to the SPA shell, so loading the embed
// page top-level still works unchanged.

import { fetchJson, UpstreamUnavailable, upstreamUnavailableResponse, siteUrl, type PagesEnv } from "../../_shared/blog-render";
import { serveSpaShell } from "../../_shared/spa-shell";
import {
  gradeEmbedCardHtml,
  gradeEmbedWidgetJs,
  readEmbedBranding,
  type PublicCertificate,
} from "./widget";

interface CertResponse {
  certificate: PublicCertificate;
}

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const WIDGET_CACHE_CONTROL =
  // Short: branding rides the query string, so downstream caches must key on the
  // full URL (they do). Public data, so a modest shared-cache TTL is fine.
  "public, max-age=600, s-maxage=600, stale-while-revalidate=86400";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  const rawId = String(params.id ?? "").trim();

  // The `[id]` route also matches the legacy standalone SPA page at
  // /embed/grade/:id. Only a `.js` request is the widget; anything else falls
  // through to the SPA shell so that page keeps working unchanged.
  if (!/\.js$/i.test(rawId)) {
    return serveSpaShell(request, env);
  }

  const id = rawId.replace(/\.js$/i, "");
  if (!id) return noopScript();

  // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
  // null when it could not reach the API — so a transient failure can never
  // again be reported to a crawler as "this page is gone".
  let data: CertResponse | null;
  try {
    data = await fetchJson<CertResponse>(
    env,
    `/api/content/public/certificates/${encodeURIComponent(id)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  // Non-public / flagged / unknown → 404 no-op (nothing renders).
  if (!data?.certificate) return noopScript();

  const branding = readEmbedBranding(new URL(request.url));
  const certUrl = `${siteUrl(env)}/cert/${encodeURIComponent(id)}`;
  const cardHtml = gradeEmbedCardHtml(data.certificate, branding, certUrl);

  return new Response(gradeEmbedWidgetJs(id, cardHtml), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": WIDGET_CACHE_CONTROL,
      "Access-Control-Allow-Origin": "*",
    },
  });
};

// 404 no-op JS for an unknown / non-public certificate. A 404 means the host's
// <script> simply doesn't execute, so nothing renders. The body is a harmless
// comment so a manual fetch sees a clear reason.
function noopScript(): Response {
  return new Response("/* GradeThread: grade not available */", {
    status: 404,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
