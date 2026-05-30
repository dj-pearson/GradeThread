// US-307: shared brand template for dynamic Open Graph / social-share images.
//
// `workers-og` (Satori + resvg-wasm in WebAssembly) accepts HTML and emits a
// 1200x630 PNG inside a Cloudflare Pages Function. We keep the markup minimal
// and brand-consistent: brand-navy background, brand-red accent, white text,
// big readable typography. NO external fonts (Satori would need them shipped
// — using system fallbacks keeps the worker bundle small and reliable).

const BRAND_NAVY = "#0F3460";
const BRAND_RED = "#E94560";
const BRAND_NIGHT = "#1A1A2E";
const TEXT_LIGHT = "#F5F5F5";

export interface CertOgInput {
  title: string;
  brand: string | null;
  score: number; // 0..10, half-points
  gradeTier: string;
  heroImageUrl?: string | null;
}

export interface BlogOgInput {
  title: string;
  category: string | null;
  authorName: string | null;
  publishedAt: string | null;
  heroImageUrl?: string | null;
}

// Inline-style HTML for Satori. We don't use external CSS — every style must
// live on the element. Flexbox is the only layout primitive Satori reliably
// supports; we avoid grid and float entirely.

export function buildCertOgHtml(input: CertOgInput): string {
  const score = input.score.toFixed(1);
  return `<div style="display:flex;flex-direction:column;height:630px;width:1200px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:60px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:44px;height:44px;border-radius:10px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;color:#fff;">G</div>
      <div style="font-size:24px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:8px 16px;border-radius:999px;font-size:18px;font-weight:500;">
      Verified Condition Grade
    </div>
  </div>

  <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin-top:20px;">
    <div style="display:flex;font-size:22px;color:rgba(255,255,255,0.7);margin-bottom:8px;">
      ${escapeHtml(input.brand ?? "Pre-owned garment")}
    </div>
    <div style="display:flex;font-size:54px;font-weight:700;line-height:1.1;margin-bottom:24px;max-width:780px;">
      ${escapeHtml(truncate(input.title, 80))}
    </div>
    <div style="display:flex;align-items:flex-end;gap:24px;">
      <div style="display:flex;flex-direction:column;">
        <div style="font-size:140px;font-weight:800;color:${BRAND_RED};line-height:1;">${score}</div>
      </div>
      <div style="display:flex;flex-direction:column;padding-bottom:24px;">
        <div style="font-size:18px;color:rgba(255,255,255,0.6);">out of 10</div>
        <div style="font-size:32px;font-weight:600;">${escapeHtml(input.gradeTier)}</div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;font-size:18px;color:rgba(255,255,255,0.6);">
    <div>AI-graded across 5 weighted factors</div>
    <div>gradethread.com</div>
  </div>
</div>`;
}

export function buildBlogOgHtml(input: BlogOgInput): string {
  const meta = [input.category, input.authorName, input.publishedAt]
    .filter((x): x is string => !!x && x.length > 0)
    .join(" · ");
  return `<div style="display:flex;flex-direction:column;height:630px;width:1200px;background:linear-gradient(135deg, ${BRAND_NAVY} 0%, ${BRAND_NIGHT} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:60px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:44px;height:44px;border-radius:10px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;color:#fff;">G</div>
      <div style="font-size:24px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:8px 16px;border-radius:999px;font-size:18px;font-weight:500;">
      Blog
    </div>
  </div>

  <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin-top:20px;">
    <div style="display:flex;font-size:60px;font-weight:700;line-height:1.15;color:#fff;max-width:1000px;">
      ${escapeHtml(truncate(input.title, 140))}
    </div>
  </div>

  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;font-size:20px;color:rgba(255,255,255,0.7);">
    <div>${escapeHtml(meta || "GradeThread Insights")}</div>
    <div>gradethread.com</div>
  </div>
</div>`;
}

// 1x1 transparent PNG fallback — last-resort if Satori itself throws. The
// blog/cert SSR still has its own static `logo_icon_512.png` fallback, so
// this path is rarely hit in practice.
export const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
