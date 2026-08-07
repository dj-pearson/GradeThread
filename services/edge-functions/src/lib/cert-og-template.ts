// Edge port of the certificate image templates (US-763/US-307), moved off the
// CPU-capped Cloudflare Pages Function (workers-og) onto the Deno edge, which
// has full CPU. These are framework-agnostic HTML-string builders fed to
// satori (see cert-image-render.ts). Ported from functions/_shared/og-template.ts
// + functions/_shared/qr.ts and brand-aligned to the current app palette
// (vault/20-domain/brand-design-system.md): Obsidian Navy / Vibrant Crimson / Midnight Coal / Pearl White.
//
// Satori constraints: flexbox only (no grid/float), inline styles only. The
// font is Inter (shipped as bytes by cert-image-render.ts) — templates name it
// explicitly. Weights >700 fall back to the nearest shipped weight.

import qrcode from "qrcode-generator";

// ── Brand palette (current — vault/20-domain/brand-design-system.md) ──────────────────────────────────
const BRAND_NAVY = "#0C1E36"; // Obsidian Navy
const BRAND_RED = "#F03D5F"; // Vibrant Crimson
const BRAND_NIGHT = "#0E0E1A"; // Midnight Coal
const TEXT_LIGHT = "#FAFAFC"; // Pearl White
const FONT = "Inter";

// A valid 1x1 transparent PNG — the never-broken fallback for a private/withheld
// cert or a render error (callers return HTTP 200 with this so an <img> never
// shows a broken icon and reachability probes still pass).
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

// ── QR (ported from functions/_shared/qr.ts) ─────────────────────────────
// One-<path> SVG QR over a white quiet zone, base64 as a data: URI so satori
// renders it as an <img>. Obsidian navy on white for scan contrast.
export function qrSvgDataUri(text: string, ecl: "L" | "M" | "Q" | "H" = "M"): string {
  if (!text) throw new Error("qrSvgDataUri: text is required");
  const qr = qrcode(0, ecl);
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const margin = 4;
  const dim = size + margin * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${d}" fill="${BRAND_NAVY}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ── OG card (1200x630, text-only) ────────────────────────────────────────
export interface CertOgInput {
  title: string;
  brand: string | null;
  score: number;
  gradeTier: string;
}

export function buildCertOgHtml(input: CertOgInput): string {
  const score = input.score.toFixed(1);
  return `<div style="display:flex;flex-direction:column;height:630px;width:1200px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:${FONT};padding:60px;">
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:44px;height:44px;border-radius:10px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:24px;color:#fff;">G</div>
      <div style="display:flex;font-size:24px;font-weight:600;letter-spacing:0.5px;">GradeThread</div>
    </div>
    <div style="display:flex;align-items:center;background:rgba(255,255,255,0.08);padding:8px 16px;border-radius:999px;font-size:18px;font-weight:500;">
      Verified Condition Grade
    </div>
  </div>
  <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin-top:20px;">
    <div style="display:flex;font-size:22px;color:rgba(255,255,255,0.7);margin-bottom:8px;">${escapeHtml(input.brand ?? "Pre-owned garment")}</div>
    <div style="display:flex;font-size:54px;font-weight:700;line-height:1.1;margin-bottom:24px;max-width:780px;">${escapeHtml(truncate(input.title, 80))}</div>
    <div style="display:flex;align-items:flex-end;gap:24px;">
      <div style="display:flex;font-size:140px;font-weight:700;color:${BRAND_RED};line-height:1;">${score}</div>
      <div style="display:flex;flex-direction:column;padding-bottom:24px;">
        <div style="display:flex;font-size:18px;color:rgba(255,255,255,0.6);">out of 10</div>
        <div style="display:flex;font-size:32px;font-weight:600;">${escapeHtml(input.gradeTier)}</div>
      </div>
    </div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;font-size:18px;color:rgba(255,255,255,0.6);">
    <div style="display:flex;">AI-graded across 5 weighted factors</div>
    <div style="display:flex;">gradethread.com</div>
  </div>
</div>`;
}

// ── Trust badge (700x180) ────────────────────────────────────────────────
export interface CertBadgeInput {
  score: number;
  gradeTier: string;
  title?: string | null;
}

export function buildCertBadgeHtml(input: CertBadgeInput): string {
  const score = input.score.toFixed(1);
  return `<div style="display:flex;align-items:center;height:180px;width:700px;background:${BRAND_NAVY};color:${TEXT_LIGHT};font-family:${FONT};border-radius:16px;padding:0 36px;">
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:128px;height:128px;border-radius:50%;background:${BRAND_RED};margin-right:32px;">
    <div style="display:flex;font-size:54px;font-weight:700;line-height:1;color:#fff;">${score}</div>
    <div style="display:flex;font-size:14px;color:rgba(255,255,255,0.85);">/ 10</div>
  </div>
  <div style="display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:6px;">
      <div style="width:26px;height:26px;border-radius:7px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;">G</div>
      GradeThread Verified
    </div>
    <div style="display:flex;font-size:36px;font-weight:700;line-height:1.1;">${escapeHtml(input.gradeTier)}</div>
    <div style="display:flex;font-size:16px;color:rgba(255,255,255,0.6);margin-top:6px;">AI condition grade · tap to verify</div>
  </div>
</div>`;
}

// ── Verified-seller storefront badge (US-1761) ───────────────────────────
// A profile-level trust badge keyed to the seller's verified handle (not a
// single certificate). Advertises the seller's whole track record — total
// grades earned + average grade — and links to /verified/{handle}. One
// horizontal template, scaled by height so the same markup renders the compact,
// wide, and listing-header sizes cleanly.
export interface SellerBadgeInput {
  width: number;
  height: number;
  displayName: string;
  totalGraded: number;
  /** True when total hit the stats sample ceiling — render "N+". */
  totalIsCapped: boolean;
  averageGrade: number; // 0..10; 0 ⇒ no grades yet
}

export function buildSellerBadgeHtml(input: SellerBadgeInput): string {
  // Scale every dimension off the reference 180px-tall badge.
  const s = input.height / 180;
  const px = (n: number) => Math.round(n * s);
  const avatar = px(128);
  const avg = input.averageGrade > 0 ? input.averageGrade.toFixed(1) : "—";
  const countLabel = input.totalIsCapped
    ? `${input.totalGraded}+ grades`
    : `${input.totalGraded} ${input.totalGraded === 1 ? "grade" : "grades"}`;
  const statLine = input.averageGrade > 0
    ? `${countLabel} · avg ${avg}`
    : countLabel;

  return `<div style="display:flex;align-items:center;height:${input.height}px;width:${input.width}px;background:${BRAND_NAVY};color:${TEXT_LIGHT};font-family:${FONT};border-radius:${px(16)}px;padding:0 ${px(36)}px;">
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${avatar}px;height:${avatar}px;border-radius:50%;background:${BRAND_RED};margin-right:${px(32)}px;">
    <div style="display:flex;font-size:${px(50)}px;font-weight:700;line-height:1;color:#fff;">${escapeHtml(avg)}</div>
    <div style="display:flex;font-size:${px(14)}px;color:rgba(255,255,255,0.85);">avg / 10</div>
  </div>
  <div style="display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;align-items:center;gap:${px(10)}px;font-size:${px(20)}px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:${px(6)}px;">
      <div style="width:${px(26)}px;height:${px(26)}px;border-radius:${px(7)}px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${px(15)}px;color:#fff;">G</div>
      GradeThread Verified Seller
    </div>
    <div style="display:flex;font-size:${px(36)}px;font-weight:700;line-height:1.1;">${escapeHtml(truncate(input.displayName, 28))}</div>
    <div style="display:flex;font-size:${px(16)}px;color:rgba(255,255,255,0.6);margin-top:${px(6)}px;">${escapeHtml(statLine)} · tap to verify</div>
  </div>
</div>`;
}

// ── Achievement badge card (US-1850 AC3) ─────────────────────────────────
// A shareable card for an EARNED gamification badge (rewards-badges.ts
// BADGE_CATALOG). Reuses the cert-image-render (Satori→PNG) path like the trust
// + seller badges. Tier drives the medal colour (bronze/silver/gold); the card
// is self-describing (name + what it's for) so it stands alone when shared.
const TIER_COLOR: Record<string, string> = {
  bronze: "#a97142",
  silver: "#9ca3af",
  gold: "#d4af37",
};

export interface AchievementBadgeInput {
  width: number;
  height: number;
  name: string;
  description: string;
  tier: string; // bronze | silver | gold (unknown → navy medal)
  /** e.g. "Earned Jul 2026", or null to omit. */
  earnedLabel?: string | null;
  /** Line above the name. Defaults to the achievement wording; the LEVEL card
   *  (US-1857) passes its own so a level share doesn't claim to be a medal. */
  eyebrow?: string | null;
  /** What sits in the medal. Defaults to a star; the level card puts the level
   *  number there, which is the only number that matters on it. */
  glyph?: string | null;
}

export function buildAchievementBadgeHtml(input: AchievementBadgeInput): string {
  const s = input.height / 180;
  const px = (n: number) => Math.round(n * s);
  const medal = px(128);
  const tierColor = TIER_COLOR[input.tier.toLowerCase()] ?? BRAND_NAVY;
  const tierLabel = input.tier ? input.tier.toUpperCase() : "";
  const earned = input.earnedLabel ? ` · ${escapeHtml(input.earnedLabel)}` : "";
  const eyebrow = escapeHtml(input.eyebrow?.trim() || "GradeThread Achievement");
  const glyph = escapeHtml(input.glyph?.trim() || "★");

  return `<div style="display:flex;align-items:center;height:${input.height}px;width:${input.width}px;background:${BRAND_NAVY};color:${TEXT_LIGHT};font-family:${FONT};border-radius:${px(16)}px;padding:0 ${px(36)}px;">
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${medal}px;height:${medal}px;border-radius:50%;background:${tierColor};margin-right:${px(32)}px;">
    <div style="display:flex;font-size:${px(46)}px;font-weight:700;line-height:1;color:#fff;">${glyph}</div>
    <div style="display:flex;font-size:${px(13)}px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.9);">${escapeHtml(tierLabel)}</div>
  </div>
  <div style="display:flex;flex-direction:column;flex:1;">
    <div style="display:flex;align-items:center;gap:${px(10)}px;font-size:${px(20)}px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:${px(6)}px;">
      <div style="width:${px(26)}px;height:${px(26)}px;border-radius:${px(7)}px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${px(15)}px;color:#fff;">G</div>
      ${eyebrow}
    </div>
    <div style="display:flex;font-size:${px(36)}px;font-weight:700;line-height:1.1;">${escapeHtml(truncate(input.name, 28))}</div>
    <div style="display:flex;font-size:${px(16)}px;color:rgba(255,255,255,0.6);margin-top:${px(6)}px;">${escapeHtml(truncate(input.description, 60))}${earned}</div>
  </div>
</div>`;
}

// ── Cosmetic share-card frames (US-1851 AC4) ─────────────────────────────
// A level unlocks a FRAME: an extra overlay template drawn over the slab. It is
// decoration and nothing else — the grade, the QR and the certificate id are
// identical with or without one, so a framed card is never a more (or less)
// credible card. Keys mirror COSMETIC_PERKS in rewards-levels.ts, which owns the
// level gate; this file only knows how to draw them.
interface CardFrame {
  /** Keyline colour drawn just inside the card edge. */
  keyline: string;
  /** Keyline thickness at the reference 1080px width. */
  weight: number;
  /** Corner plate fill + text, or null for a keyline-only frame. */
  plateBg: string | null;
  plateText: string;
  /** The word on the plate — the tier the frame belongs to. */
  label: string;
}

const CARD_FRAMES: Record<string, CardFrame> = {
  frame_slate: {
    keyline: "rgba(250,250,252,0.35)",
    weight: 6,
    plateBg: null,
    plateText: TEXT_LIGHT,
    label: "Picker",
  },
  frame_curator: {
    keyline: BRAND_RED,
    weight: 8,
    plateBg: BRAND_RED,
    plateText: "#ffffff",
    label: "Curator",
  },
  frame_archive: {
    keyline: "#7a8aa3",
    weight: 10,
    plateBg: "#1b2c45",
    plateText: TEXT_LIGHT,
    label: "Archivist",
  },
  frame_legend: {
    keyline: "#d4af37",
    weight: 12,
    plateBg: "#d4af37",
    plateText: "#1a1a2e",
    label: "Legend",
  },
};

export function isCardFrameKey(v: unknown): v is string {
  return typeof v === "string" && Object.hasOwn(CARD_FRAMES, v);
}

/**
 * The frame overlay for a card of `width` × `height`, or "" for no/unknown frame.
 * Absolutely positioned over the whole card, so it composes with any slab format
 * without touching the layout underneath.
 */
export function buildCardFrameHtml(
  frameKey: string | null | undefined,
  width: number,
  height: number,
): string {
  if (!frameKey) return "";
  const f = CARD_FRAMES[frameKey];
  if (!f) return "";
  const s = width / 1080;
  const px = (n: number) => Math.max(1, Math.round(n * s));
  const w = px(f.weight);
  const plate = f.plateBg
    ? `<div style="display:flex;position:absolute;top:${px(28)}px;right:${px(28)}px;align-items:center;background:${f.plateBg};color:${f.plateText};border-radius:999px;padding:${px(8)}px ${px(20)}px;font-size:${px(22)}px;font-weight:700;letter-spacing:${px(1)}px;">${escapeHtml(f.label.toUpperCase())}</div>`
    : "";
  return `<div style="display:flex;position:absolute;top:0;left:0;width:${width}px;height:${height}px;border:${w}px solid ${f.keyline};border-radius:${px(24)}px;"></div>${plate}`;
}

// ── Digital slab (PSA-style graded photo) ────────────────────────────────
export interface CertSlabInput {
  width: number;
  height: number;
  title: string;
  brand: string | null;
  score: number;
  gradeTier: string;
  heroImageUrl?: string | null; // a data: URI (pre-fetched by the renderer)
  qrDataUri: string;
  certId: string;
  /** US-1851: cosmetic frame key, already level-gated by the caller. */
  frameKey?: string | null;
}

export function buildCertSlabHtml(input: CertSlabInput): string {
  const score = input.score.toFixed(1);
  const pad = 48;
  const certIdShort = input.certId.slice(0, 8);
  const hasHero = !!input.heroImageUrl;

  const stageInner = hasHero
    ? `<img src="${input.heroImageUrl as string}" style="width:100%;height:100%;object-fit:cover;" />`
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;">
        <div style="display:flex;font-size:200px;font-weight:700;color:${BRAND_RED};line-height:1;">${score}</div>
        <div style="display:flex;font-size:38px;font-weight:600;color:#fff;margin-top:8px;">${escapeHtml(input.gradeTier)}</div>
        <div style="display:flex;font-size:20px;color:rgba(255,255,255,0.6);margin-top:4px;">out of 10</div>
      </div>`;

  const chip = hasHero
    ? `<div style="display:flex;position:absolute;left:20px;bottom:20px;align-items:center;background:rgba(12,30,54,0.88);border-radius:999px;padding:10px 22px 10px 10px;">
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:84px;height:84px;border-radius:50%;background:${BRAND_RED};margin-right:14px;">
          <div style="display:flex;font-size:38px;font-weight:700;color:#fff;line-height:1;">${score}</div>
          <div style="display:flex;font-size:12px;color:rgba(255,255,255,0.85);">/ 10</div>
        </div>
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;font-size:16px;color:rgba(255,255,255,0.8);">GradeThread Verified</div>
          <div style="display:flex;font-size:26px;font-weight:700;color:#fff;">${escapeHtml(input.gradeTier)}</div>
        </div>
      </div>`
    : "";

  return `<div style="display:flex;flex-direction:column;position:relative;height:${input.height}px;width:${input.width}px;background:linear-gradient(135deg, ${BRAND_NIGHT} 0%, ${BRAND_NAVY} 100%);color:${TEXT_LIGHT};font-family:${FONT};padding:${pad}px;">
  ${buildCardFrameHtml(input.frameKey, input.width, input.height)}
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:48px;height:48px;border-radius:11px;background:${BRAND_RED};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:26px;color:#fff;">G</div>
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
