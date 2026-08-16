// US-860: embeddable "GradeThread Verified" trust badge as a tiny script.
//
// /embed/cert/:id serves a small JavaScript widget a seller pastes into any
// site that allows scripts (Shopify, a personal store, a blog). On load it
// injects a linked PNG badge (/badge/cert/:id) right where the <script> tag
// sits; the link drives buyers to the live certificate, carrying ?s=embed for
// share-source attribution (US-769). This is the script counterpart to the
// plain img-element snippet (certBadgeEmbedHtml) which survives marketplace HTML
// sanitizers — sellers paste whichever their channel allows.
//
// Why a script and not an iframe: the zone ships X-Frame-Options: DENY +
// CSP frame-ancestors 'none' (anti-clickjacking, public/_headers), and
// Cloudflare Pages _headers JOINS duplicate header values rather than letting
// a per-path rule override them — so a same-origin iframe can never be framed
// cross-site without weakening the whole app's clickjacking posture. A script
// injects straight into the host DOM and is immune to framing restrictions.
//
// Guard (AC#4): only public, non-flagged certificates render. The widget first
// confirms the cert via the same anonymous endpoint the cert SSR uses, which
// hard-filters flagged/private reports (US-484/US-268); a miss yields a 404
// no-op script so nothing renders on the host page.

import { fetchJson, UpstreamUnavailable, upstreamUnavailableResponse, siteUrl, type PagesEnv } from "../../_shared/blog-render";
import { headOf } from "../../_shared/head-of";

interface PublicCertificate {
  id: string;
  overall_score: number;
  grade_tier: string;
}

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const EMBED_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  // Tolerate a trailing ".js" so the snippet's src can read like a script file.
  const id = String(params.id ?? "")
    .trim()
    .replace(/\.js$/i, "");
  if (!id) return noopScript();

  // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
  // null when it could not reach the API — so a transient failure can never
  // again be reported to a crawler as "this page is gone".
  let data: { certificate: PublicCertificate } | null;
  try {
    data = await fetchJson<{ certificate: PublicCertificate }>(
    env,
    `/api/content/public/certificates/${encodeURIComponent(id)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  // Non-public / flagged / unknown → 404 no-op (nothing renders).
  if (!data?.certificate) return noopScript();

  const base = siteUrl(env);
  // US-1913: the seller picks the plain or the STATUS format of the badge in
  // Badge Studio; the script src carries the choice through to the injected
  // img element. `?s=embed` is unchanged (AC5) — `&v=status` is the separate marker
  // that lets status click-throughs be compared against plain ones.
  const statusRaw = (new URL(request.url).searchParams.get("status") ?? "")
    .trim()
    .toLowerCase();
  const status = statusRaw === "1" || statusRaw === "true" ||
    statusRaw === "status" || statusRaw === "yes";
  // ?s=embed lets an embed-sourced view be attributed (US-769) without any PII.
  const certUrl = `${base}/cert/${encodeURIComponent(id)}?s=embed${status ? "&v=status" : ""}`;
  const badgeUrl = `${base}/badge/cert/${encodeURIComponent(id)}${status ? "?status=1" : ""}`;

  return new Response(badgeWidgetJs(id, certUrl, badgeUrl), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": EMBED_CACHE_CONTROL,
      // Loaded via <script src> (no CORS needed), but harmless + lets a host
      // fetch() the widget too.
      "Access-Control-Allow-Origin": "*",
    },
  });
};

// 404 no-op JS for an unknown / non-public certificate. A 404 means the host's
// <script> simply doesn't execute, so nothing renders (AC#4). The body is a
// harmless comment so a manual fetch sees a clear reason.
function noopScript(): Response {
  return new Response("/* GradeThread: certificate not available */", {
    status: 404,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// The injectable widget. Finds its own <script> tag (works even when the seller
// adds `async`, where document.currentScript is null) and inserts a linked
// badge img element right after it. Idempotent via a data-flag so a double-include
// can't render two badges. All dynamic values are JSON-encoded so they're safe
// inside the generated JS string literals.
function badgeWidgetJs(id: string, certUrl: string, badgeUrl: string): string {
  const idJson = JSON.stringify(id);
  const certJson = JSON.stringify(certUrl);
  const badgeJson = JSON.stringify(badgeUrl);
  return `(function(){
  try {
    var d = document;
    var self = d.currentScript;
    if (!self) {
      var marker = "/embed/cert/" + ${idJson};
      var ss = d.getElementsByTagName("script");
      for (var i = ss.length - 1; i >= 0; i--) {
        if (ss[i].src && ss[i].src.indexOf(marker) > -1) { self = ss[i]; break; }
      }
    }
    if (!self || self.getAttribute("data-gt-rendered")) return;
    self.setAttribute("data-gt-rendered", "1");
    var a = d.createElement("a");
    a.href = ${certJson};
    a.target = "_blank";
    a.rel = "noopener";
    a.style.cssText = "display:inline-block;line-height:0";
    var img = d.createElement("img");
    img.src = ${badgeJson};
    img.alt = "GradeThread Verified condition grade";
    img.width = 350;
    img.height = 90;
    img.loading = "lazy";
    img.style.cssText = "max-width:100%;height:auto;border:0";
    a.appendChild(img);
    self.parentNode.insertBefore(a, self.nextSibling);
  } catch (e) {}
})();`;
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
