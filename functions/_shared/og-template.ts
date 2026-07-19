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

export interface SellerOgInput {
  displayName: string;
  totalGraded: number;
  averageGrade: number; // 0..10
  totalIsCapped?: boolean;
}

// 1200x630 share card for a public seller profile (/verified/<handle>).
export function buildSellerOgHtml(input: SellerOgInput): string {
  const avg = input.averageGrade > 0 ? input.averageGrade.toFixed(1) : "—";
  const count = input.totalIsCapped
    ? `${input.totalGraded.toLocaleString()}+`
    : input.totalGraded.toLocaleString();
  return `<div style="display:flex;flex-direction:column;height:630px;width:1200px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:60px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:44px;height:44px;border-radius:10px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;color:#fff;">G</div>
      <div style="font-size:24px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:8px 16px;border-radius:999px;font-size:18px;font-weight:500;">
      ✓ Verified Seller
    </div>
  </div>

  <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin-top:20px;">
    <div style="display:flex;font-size:22px;color:rgba(255,255,255,0.7);margin-bottom:8px;">GradeThread Verified Seller</div>
    <div style="display:flex;font-size:64px;font-weight:700;line-height:1.1;max-width:1000px;">
      ${escapeHtml(truncate(input.displayName, 60))}
    </div>
  </div>

  <div style="display:flex;align-items:flex-end;gap:56px;width:100%;">
    <div style="display:flex;flex-direction:column;">
      <div style="font-size:72px;font-weight:800;color:${BRAND_RED};line-height:1;">${escapeHtml(count)}</div>
      <div style="font-size:18px;color:rgba(255,255,255,0.6);">items graded</div>
    </div>
    <div style="display:flex;flex-direction:column;">
      <div style="font-size:72px;font-weight:800;color:#fff;line-height:1;">${escapeHtml(avg)}</div>
      <div style="font-size:18px;color:rgba(255,255,255,0.6);">avg grade · out of 10</div>
    </div>
    <div style="display:flex;flex:1;justify-content:flex-end;font-size:18px;color:rgba(255,255,255,0.6);align-items:flex-end;height:100%;">gradethread.com</div>
  </div>
</div>`;
}

export interface CertBadgeInput {
  score: number; // 0..10
  gradeTier: string;
  title?: string | null;
}

// Compact embeddable trust badge (700x180) for a single graded item. Sellers
// drop this — wrapped in a link to the certificate — into their eBay /
// Poshmark / Mercari listing description so buyers see a standardized,
// verifiable condition grade right inside the listing.
export function buildCertBadgeHtml(input: CertBadgeInput): string {
  const score = input.score.toFixed(1);
  return `<div style="display:flex;align-items:center;height:180px;width:700px;background:${BRAND_NAVY};color:${TEXT_LIGHT};font-family:system-ui,sans-serif;border-radius:16px;padding:0 36px;">
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:128px;height:128px;border-radius:50%;background:${BRAND_RED};margin-right:32px;">
    <div style="font-size:54px;font-weight:800;line-height:1;color:#fff;">${score}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.85);">/ 10</div>
  </div>
  <div style="display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:6px;">
      <div style="width:26px;height:26px;border-radius:7px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;">G</div>
      GradeThread Verified
    </div>
    <div style="display:flex;font-size:36px;font-weight:800;line-height:1.1;">${escapeHtml(input.gradeTier)}</div>
    <div style="display:flex;font-size:16px;color:rgba(255,255,255,0.6);margin-top:6px;">AI condition grade · tap to verify</div>
  </div>
</div>`;
}

// ─── Digital Slab (US-763) ────────────────────────────────────────────────
// The PSA-style "graded photo": the garment's own image with the grade and a
// scannable QR burned in. A seller drops this single certified image into any
// marketplace listing; a buyer sees the official grade on the thumbnail and
// scans/taps through to the full certificate. Rendered by Satori (workers-og)
// from functions/slab/cert/[id].ts.

export interface CertSlabInput {
  width: number;
  height: number;
  title: string;
  brand: string | null;
  score: number; // 0..10, half-points
  gradeTier: string;
  heroImageUrl?: string | null;
  qrDataUri: string; // from functions/_shared/qr.ts → qrSvgDataUri()
  certId: string;
}

export function buildCertSlabHtml(input: CertSlabInput): string {
  const score = input.score.toFixed(1);
  const pad = 48;
  const certIdShort = input.certId.slice(0, 8);
  const hasHero = !!input.heroImageUrl;

  // The stage is the photo (or, with no photo, a label-only card). Flex:1 lets
  // it fill the space between the header and footer at any aspect ratio.
  const stageInner = hasHero
    ? `<img src="${escapeHtml(input.heroImageUrl as string)}" style="width:100%;height:100%;object-fit:cover;" />`
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;">
        <div style="display:flex;font-size:200px;font-weight:800;color:${BRAND_RED};line-height:1;">${score}</div>
        <div style="display:flex;font-size:38px;font-weight:600;color:#fff;margin-top:8px;">${escapeHtml(input.gradeTier)}</div>
        <div style="display:flex;font-size:20px;color:rgba(255,255,255,0.6);margin-top:4px;">out of 10</div>
      </div>`;

  // PSA-style grade chip, pinned over the photo's bottom-left. Skipped when
  // there's no photo (the label-only card already shows the score big).
  const chip = hasHero
    ? `<div style="display:flex;position:absolute;left:20px;bottom:20px;align-items:center;background:rgba(12,30,54,0.88);border-radius:999px;padding:10px 22px 10px 10px;">
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:84px;height:84px;border-radius:50%;background:${BRAND_RED};margin-right:14px;">
          <div style="font-size:38px;font-weight:800;color:#fff;line-height:1;">${score}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.85);">/ 10</div>
        </div>
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;font-size:16px;color:rgba(255,255,255,0.8);">GradeThread Verified</div>
          <div style="display:flex;font-size:26px;font-weight:700;color:#fff;">${escapeHtml(input.gradeTier)}</div>
        </div>
      </div>`
    : "";

  return `<div style="display:flex;flex-direction:column;height:${input.height}px;width:${input.width}px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:${pad}px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:48px;height:48px;border-radius:11px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:26px;color:#fff;">G</div>
      <div style="display:flex;font-size:26px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:9px 18px;border-radius:999px;font-size:19px;font-weight:500;">
      Verified Condition Grade
    </div>
  </div>

  <div style="display:flex;position:relative;width:100%;flex:1;margin:24px 0;">
    <div style="display:flex;position:absolute;top:0;left:0;right:0;bottom:0;border-radius:28px;overflow:hidden;background:${BRAND_NIGHT};">
      ${stageInner}
    </div>
    ${chip}
  </div>

  <div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;">
    <div style="display:flex;flex-direction:column;flex:1;padding-right:24px;">
      <div style="display:flex;font-size:22px;color:rgba(255,255,255,0.65);margin-bottom:6px;">${escapeHtml(input.brand ?? "Pre-owned garment")}</div>
      <div style="display:flex;font-size:40px;font-weight:700;line-height:1.1;">${escapeHtml(truncate(input.title, 52))}</div>
      <div style="display:flex;font-size:18px;color:rgba(255,255,255,0.55);margin-top:14px;">AI-graded · gradethread.com/cert/${escapeHtml(certIdShort)}…</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;background:#fff;border-radius:20px;padding:14px;">
      <img src="${input.qrDataUri}" style="width:172px;height:172px;" />
      <div style="display:flex;font-size:15px;font-weight:600;color:${BRAND_NAVY};margin-top:8px;">Scan to verify</div>
    </div>
  </div>
</div>`;
}

// ─── Social cards (US-871) ────────────────────────────────────────────────
// Branded "no-asset-needed" social card: when a social post ships without its
// own image, the publish path auto-fills a URL to this template so every
// network gets an on-brand image. Rendered by functions/og/social/card.ts in
// each network's native aspect ratio.

export type SocialCardRatio = "landscape" | "square" | "portrait" | "pin";

// The four sizes each network needs. landscape = X/LinkedIn/Facebook,
// square = Instagram square/Threads, portrait = Instagram portrait,
// pin = Pinterest vertical.
export const SOCIAL_CARD_SIZES: Record<
  SocialCardRatio,
  { width: number; height: number }
> = {
  landscape: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  pin: { width: 1000, height: 1500 },
};

export function isSocialCardRatio(v: unknown): v is SocialCardRatio {
  return v === "landscape" || v === "square" || v === "portrait" || v === "pin";
}

export type SocialCardKind = "title" | "quote" | "stat";

export interface SocialCardInput {
  ratio: SocialCardRatio;
  // title → headline; quote → pull-quote; stat → big number + caption.
  kind: SocialCardKind;
  // The headline / pull-quote / stat caption.
  text: string;
  // For kind="stat": the big value, e.g. "9.5" or "1.0–10.0".
  stat?: string | null;
  product?: "gradethread" | "flipdesk" | "both";
  // Small label above the main text (e.g. "Condition grading").
  eyebrow?: string | null;
}

const PRODUCT_BADGE: Record<NonNullable<SocialCardInput["product"]>, string> = {
  gradethread: "GradeThread",
  flipdesk: "FlipDesk",
  both: "GradeThread + FlipDesk",
};

// One template, four aspect ratios. Typography scales off the card width so a
// 1.91:1 banner and a 2:3 pin both read cleanly. Flexbox only (Satori), no
// external fonts.
export function buildSocialCardHtml(input: SocialCardInput): string {
  const { width, height } = SOCIAL_CARD_SIZES[input.ratio] ??
    SOCIAL_CARD_SIZES.landscape;
  const pad = Math.round(width * 0.06);
  const mark = Math.round(width * 0.037);
  const badgeLabel = PRODUCT_BADGE[input.product ?? "gradethread"];
  const eyebrow = input.eyebrow?.trim();

  // Main content per kind. Sizes are proportional to the card width.
  const titleSize = Math.round(width * 0.058);
  const statSize = Math.round(width * 0.18);
  const captionSize = Math.round(width * 0.03);

  let main: string;
  if (input.kind === "stat") {
    const statText = (input.stat ?? "").trim() || "—";
    main = `<div style="display:flex;flex-direction:column;">
      <div style="display:flex;font-size:${statSize}px;font-weight:800;color:${BRAND_RED};line-height:1;">${escapeHtml(truncate(statText, 12))}</div>
      <div style="display:flex;font-size:${captionSize}px;font-weight:600;color:#fff;line-height:1.2;margin-top:${Math.round(width * 0.02)}px;max-width:${width - pad * 2}px;">${escapeHtml(truncate(input.text, 120))}</div>
    </div>`;
  } else if (input.kind === "quote") {
    main = `<div style="display:flex;flex-direction:column;">
      <div style="display:flex;font-size:${Math.round(width * 0.12)}px;font-weight:800;color:${BRAND_RED};line-height:0.8;height:${Math.round(width * 0.07)}px;">“</div>
      <div style="display:flex;font-size:${titleSize}px;font-weight:700;line-height:1.2;color:#fff;max-width:${width - pad * 2}px;">${escapeHtml(truncate(input.text, 200))}</div>
    </div>`;
  } else {
    main = `<div style="display:flex;font-size:${titleSize}px;font-weight:700;line-height:1.15;color:#fff;max-width:${width - pad * 2}px;">${escapeHtml(truncate(input.text, 160))}</div>`;
  }

  const eyebrowBlock = eyebrow
    ? `<div style="display:flex;font-size:${captionSize}px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${BRAND_RED};margin-bottom:${Math.round(width * 0.02)}px;">${escapeHtml(truncate(eyebrow, 48))}</div>`
    : "";

  return `<div style="display:flex;flex-direction:column;height:${height}px;width:${width}px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:${pad}px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:${Math.round(mark * 0.4)}px;">
      <div style="width:${Math.round(mark * 1.7)}px;height:${Math.round(mark * 1.7)}px;border-radius:${Math.round(mark * 0.4)}px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${mark}px;color:#fff;">G</div>
      <div style="display:flex;font-size:${mark}px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:${Math.round(mark * 0.35)}px ${Math.round(mark * 0.7)}px;border-radius:999px;font-size:${Math.round(mark * 0.72)}px;font-weight:500;">
      ${escapeHtml(badgeLabel)}
    </div>
  </div>

  <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin:${Math.round(width * 0.025)}px 0;">
    ${eyebrowBlock}
    ${main}
  </div>

  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;font-size:${captionSize}px;color:rgba(255,255,255,0.6);">
    <div>Verified condition grading</div>
    <div>gradethread.com</div>
  </div>
</div>`;
}

// ─── Free grade-check result card (US-1752) ───────────────────────────────
// A shareable, on-brand landscape card for a result from the free, no-signup
// grade checker (/tools/grade-checker). Rendered by functions/og/grade-check.ts
// entirely from query-string values, so it is STATELESS and carries NO PII —
// only the grade, tier, an aggregate value RANGE, and an optional brand/item
// label the sharer typed. The QR points back at the free tool so a share loops
// new visitors into the funnel.

export interface GradeResultCardInput {
  width: number;
  height: number;
  score: number; // 0..10, half-points
  gradeTier: string;
  brand?: string | null;
  itemLabel?: string | null;
  /** Pre-formatted aggregate value range, e.g. "$15 – $26". Never a per-item price. */
  valueText?: string | null;
  qrDataUri: string; // from functions/_shared/qr.ts → qrSvgDataUri()
}

export function buildGradeResultCardHtml(input: GradeResultCardInput): string {
  const score = input.score.toFixed(1);
  const pad = 60;
  const subject = [input.brand, input.itemLabel]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" · ");

  const valueBlock = input.valueText
    ? `<div style="display:flex;flex-direction:column;align-items:flex-start;">
        <div style="display:flex;font-size:20px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:1px;">Estimated resale value</div>
        <div style="display:flex;font-size:72px;font-weight:800;color:#fff;line-height:1.05;margin-top:6px;">${escapeHtml(input.valueText)}</div>
        <div style="display:flex;font-size:18px;color:rgba(255,255,255,0.5);margin-top:6px;">at this condition · a range, not a guaranteed price</div>
      </div>`
    : `<div style="display:flex;flex-direction:column;align-items:flex-start;">
        <div style="display:flex;font-size:26px;font-weight:600;color:#fff;">Free condition grade</div>
        <div style="display:flex;font-size:18px;color:rgba(255,255,255,0.55);margin-top:8px;max-width:420px;">Add a brand + item to also see an estimated resale value.</div>
      </div>`;

  return `<div style="display:flex;flex-direction:column;height:${input.height}px;width:${input.width}px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:system-ui,sans-serif;padding:${pad}px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:48px;height:48px;border-radius:11px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:26px;color:#fff;">G</div>
      <div style="display:flex;font-size:26px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:9px 18px;border-radius:999px;font-size:19px;font-weight:500;">
      Free grade estimate
    </div>
  </div>

  <div style="display:flex;align-items:center;flex:1;width:100%;margin:20px 0;">
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:320px;">
      <div style="display:flex;font-size:170px;font-weight:800;color:${BRAND_RED};line-height:1;">${score}</div>
      <div style="display:flex;font-size:34px;font-weight:600;color:#fff;margin-top:4px;">${escapeHtml(input.gradeTier)}</div>
      <div style="display:flex;font-size:19px;color:rgba(255,255,255,0.55);margin-top:2px;">out of 10</div>
    </div>
    <div style="display:flex;flex:1;padding-left:40px;">
      ${valueBlock}
    </div>
  </div>

  <div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;">
    <div style="display:flex;flex-direction:column;flex:1;padding-right:24px;">
      ${subject ? `<div style="display:flex;font-size:22px;color:rgba(255,255,255,0.65);margin-bottom:6px;">${escapeHtml(truncate(subject, 48))}</div>` : ""}
      <div style="display:flex;font-size:20px;color:rgba(255,255,255,0.55);">Estimate from one photo · gradethread.com/tools/grade-checker</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;background:#fff;border-radius:20px;padding:14px;">
      <img src="${input.qrDataUri}" style="width:150px;height:150px;" />
      <div style="display:flex;font-size:15px;font-weight:600;color:${BRAND_NAVY};margin-top:8px;">Scan to try it free</div>
    </div>
  </div>
</div>`;
}

// 1x1 transparent PNG — the LAST-resort fallback, after the branded card below
// has also failed. Prefer brandedFallbackResponse() for anything that ends up in
// an og:image: a transparent pixel renders as a BLANK link preview, which is
// worse for click-through than a generic branded card, and it is cached by
// scrapers we do not control.
//
// Still correct for non-OG surfaces (badge/*, slab/*): those have their own
// dimensions and an invisible badge is a better degradation than a wrong-shaped
// brand card stretched into a badge slot.
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


/**
 * US-2108 AC3: a BRANDED fallback for og:image endpoints.
 *
 * Every og/* function previously degraded to FALLBACK_PNG_BASE64 — a 1x1
 * transparent PNG. Crawlers accept it, which is why it survived, but "accepted"
 * is not the bar: the shared link renders with a blank preview. On the
 * certificate share path — the designated organic acquisition loop — that turns
 * the highest-intent share we have into an invisible one.
 *
 * Falls back to the static /og-image.png (the site-wide 1200x630 brand card,
 * already shipped and already the default og:image for unlisted routes), fetched
 * same-origin. If THAT fails too we return the transparent pixel, because an
 * endpoint that 500s is worse than one that degrades quietly.
 *
 * CACHE TTL IS DELIBERATELY SHORT (300s, not the 24h a real card gets). This
 * response means "upstream was unavailable", which is usually transient — caching
 * a generic card for a day at a scraper we cannot purge would outlast the outage
 * that caused it, and every share created in that window would keep the wrong
 * image permanently.
 */
export async function brandedFallbackResponse(siteOrigin: string): Promise<Response> {
  try {
    const res = await fetch(`${siteOrigin}/og-image.png`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok && res.body) {
      return new Response(res.body, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          // Lets a log or a curl tell a real card from a degraded one, which is
          // otherwise invisible — both are a 200 with PNG bytes.
          "X-GT-Fallback": "branded",
        },
      });
    }
  } catch {
    /* fall through to the transparent pixel */
  }
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "X-GT-Fallback": "transparent",
    },
  });
}
