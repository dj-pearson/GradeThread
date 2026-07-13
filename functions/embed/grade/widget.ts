// US-1936: pure builders for the white-label grade embed script widget.
//
// Kept free of the Cloudflare worker globals (PagesFunction/EventContext) that
// live in [id].ts, so these can be imported + unit-tested from the Vitest/`src`
// side (whose tsconfig only pulls DOM libs, not @cloudflare/workers-types) —
// the same split og-template.ts uses for its social-card builders.
//
// See [id].ts for the delivery model rationale (why a script widget, not an
// iframe) and the public-endpoint privacy guard.

import { escape } from "../../_shared/blog-render";

export interface PublicCertificate {
  id: string;
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
}

// Factor labels mirror src/lib/constants.ts GRADE_FACTORS + the /cert SSR
// (functions/cert/[id].ts). Duplicated (small, stable) to keep the worker
// dependency-free. Order = display order (highest weight first).
const FACTORS: Array<{ key: keyof PublicCertificate; label: string }> = [
  { key: "fabric_condition_score", label: "Fabric Condition" },
  { key: "structural_integrity_score", label: "Structural Integrity" },
  { key: "cosmetic_appearance_score", label: "Cosmetic Appearance" },
  { key: "functional_elements_score", label: "Functional Elements" },
  { key: "odor_cleanliness_score", label: "Odor & Cleanliness" },
];

const BRAND_NAVY = "#0F3460";

// Grade → accent colour. Mirrors src/pages/embed-grade.tsx scoreColor so the
// widget card matches the standalone SPA embed page.
function scoreColor(score: number): string {
  if (score > 7) return "#10B981"; // emerald
  if (score >= 5) return "#F59E0B"; // amber
  return "#F03D5F"; // crimson
}

// Branding validators — the embed URL is fully attacker-craftable, so every
// value that lands in an attribute is constrained. Mirrors the SPA embed page's
// safeEmbedUrl() + hex check (src/lib/return-to.ts, src/pages/embed-grade.tsx);
// duplicated here because the edge worker can't import the Vite-side src/lib.

/** An absolute https:// URL (for logo/support), else null so the caller omits it. */
export function safeEmbedHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null; // relative / protocol-relative / malformed
  }
}

/** A #rrggbb hex colour, else the brand navy fallback. */
export function safeEmbedColor(raw: string | null | undefined): string {
  return /^#[0-9a-fA-F]{6}$/.test(raw ?? "") ? (raw as string) : BRAND_NAVY;
}

export interface EmbedBranding {
  company: string | null;
  color: string;
  logo: string | null;
  support: string | null;
}

/** Extract + validate the branding params from the widget request URL. */
export function readEmbedBranding(url: URL): EmbedBranding {
  const company = url.searchParams.get("company");
  return {
    company: company && company.trim() ? company.trim().slice(0, 80) : null,
    color: safeEmbedColor(url.searchParams.get("color")),
    logo: safeEmbedHttpsUrl(url.searchParams.get("logo")),
    support: safeEmbedHttpsUrl(url.searchParams.get("support")),
  };
}

/**
 * The branded grade card as an inline-styled HTML string. Pure + fully escaped so
 * it's safe to inject via innerHTML on the host page (no host CSP script hooks,
 * only style attributes) and unit-testable. `certUrl` is the absolute /cert/:id
 * link for the "Verified by GradeThread" attribution.
 */
export function gradeEmbedCardHtml(
  cert: PublicCertificate,
  branding: EmbedBranding,
  certUrl: string,
): string {
  const overall = Number(cert.overall_score);
  const overallColor = scoreColor(overall);
  const header = branding.logo
    ? `<img src="${escape(branding.logo)}" alt="${escape(branding.company ?? "Partner")}" style="height:28px;width:auto;display:block">`
    : `<span style="font-size:20px;line-height:1;color:#fff" aria-hidden="true">&#10003;</span>`;

  const factorsHtml = FACTORS.map((f) => {
    const v = Number(cert[f.key]);
    const pct = Math.max(0, Math.min(100, v * 10));
    const c = scoreColor(v);
    return `<div style="margin:0 0 10px">
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span style="font-weight:500">${escape(f.label)}</span>
        <span style="font-variant-numeric:tabular-nums;color:${c}">${v.toFixed(1)}</span>
      </div>
      <div style="margin-top:4px;height:6px;width:100%;overflow:hidden;border-radius:999px;background:#f1f5f9">
        <div style="height:100%;border-radius:999px;width:${pct}%;background:${c}"></div>
      </div>
    </div>`;
  }).join("");

  const supportHtml = branding.support
    ? `<a href="${escape(branding.support)}" target="_blank" rel="noopener noreferrer" style="color:#64748b;text-decoration:none">Support</a>`
    : "";

  const titleHtml = cert.title
    ? `<p style="margin:4px 0 0;font-size:14px;font-weight:500;color:#0f172a">${escape(cert.title)}${
        cert.brand ? ` <span style="color:#64748b">&mdash; ${escape(cert.brand)}</span>` : ""
      }</p>`
    : "";

  // The whole card sits in one wrapper with a max width; inline styles only so it
  // survives on a host page with no stylesheet of ours.
  return `<div style="max-width:480px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Inter,sans-serif;color:#0f172a;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.05)">
    <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;background:${branding.color}">
      ${header}
      <div style="color:#fff">
        <p style="margin:0;font-size:14px;font-weight:600;line-height:1.2">${escape(branding.company ?? "Verified Condition Grade")}</p>
        <p style="margin:0;font-size:11px;opacity:0.8">Condition grade</p>
      </div>
    </div>
    <div style="padding:20px">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        <div style="display:flex;height:80px;width:80px;flex-shrink:0;align-items:center;justify-content:center;border-radius:999px;border:4px solid ${overallColor}">
          <span style="font-size:28px;font-weight:700;color:${overallColor}">${overall.toFixed(1)}</span>
        </div>
        <div>
          <span style="display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:500;background:${overallColor}1a;color:${overallColor}">${escape(cert.grade_tier)}</span>
          ${titleHtml}
          <p style="margin:2px 0 0;font-size:12px;color:#64748b">Out of 10.0</p>
        </div>
      </div>
      ${factorsHtml}
      <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid #f1f5f9;padding-top:12px;margin-top:16px;font-size:11px;color:#64748b">
        <a href="${escape(certUrl)}" target="_blank" rel="noopener noreferrer" style="color:#64748b;text-decoration:none">&#10003; Verified by GradeThread</a>
        ${supportHtml}
      </div>
    </div>
  </div>`;
}

/**
 * The injectable widget JS. Finds its own <script> tag (works even with `async`,
 * where document.currentScript is null), then inserts the pre-built card right
 * after it. Idempotent via a data-flag so a double-include can't render twice.
 * The card HTML is server-built + escaped and passed as a JSON string literal.
 */
export function gradeEmbedWidgetJs(id: string, cardHtml: string): string {
  const idJson = JSON.stringify(id);
  const htmlJson = JSON.stringify(cardHtml);
  return `(function(){
  try {
    var d = document;
    var self = d.currentScript;
    if (!self) {
      var marker = "/embed/grade/" + ${idJson};
      var ss = d.getElementsByTagName("script");
      for (var i = ss.length - 1; i >= 0; i--) {
        if (ss[i].src && ss[i].src.indexOf(marker) > -1) { self = ss[i]; break; }
      }
    }
    if (!self || self.getAttribute("data-gt-rendered")) return;
    self.setAttribute("data-gt-rendered", "1");
    var wrap = d.createElement("div");
    wrap.className = "gt-grade-embed";
    wrap.innerHTML = ${htmlJson};
    self.parentNode.insertBefore(wrap, self.nextSibling);
  } catch (e) {}
})();`;
}
