/**
 * Shared email brand system — the single source of truth for the visible brand
 * surfaces used by BOTH rendering engines:
 *   • email.ts        (Engine A — transactional / broadcast / drip / journey)
 *   • email-render.ts (Engine B — marketing newsletter, modular blocks)
 *
 * Before this module, brand hex + the header/footer/button markup were
 * duplicated (and drifting) across the two files. Everything here is PURE — no
 * Deno.env reads, no network — so it stays trivially testable and both engines
 * can inject their own siteUrl / logoUrl / postal address.
 *
 * Email-client reality: gradients, box-shadow and border-radius are progressive
 * enhancements. Every component sets a solid `bgcolor` / background-color first
 * so it degrades cleanly in Outlook and legacy clients (the gradient is layered
 * on top via `background-image` and simply ignored where unsupported).
 */

// ── Brand tokens ──────────────────────────────────────────────────────────────

export const EMAIL_BRAND = {
  navy: "#0F3460", // primary / header ground (solid fallback)
  navyLight: "#123C72", // gradient highlight
  navyDeep: "#0A2547", // gradient shadow
  red: "#E94560", // accent / CTA (solid fallback)
  redLight: "#FF5B79", // CTA gradient highlight
  redDeep: "#D6304C", // CTA gradient shadow
  night: "#1A1A2E", // footer ground / dark fg
  canvas: "#F4F6FA", // navy-biased page canvas (not flat grey)
  ink: "#14203A", // headings
  body: "#4A5468", // body copy
  slate: "#5A6478", // secondary copy
  hairline: "#E4E9F1", // card borders / rules
} as const;

export const EMAIL_FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const EMAIL_MONO_STACK =
  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

export const DEFAULT_TAGLINE = "AI-Powered Condition Grading";
const LOGO_WORDMARK_PATH = "/logo_white.png"; // white GRADE + red THREAD, 4.8:1
const LOGO_MARK_PATH = "/logo_icon.png"; // square app icon, 1:1

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Escape the dangerous five for safe interpolation into HTML / attributes. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimUrl(u: string): string {
  return (u ?? "").replace(/\/+$/, "");
}

/** Absolute URLs for the hosted logo assets (they ship in the frontend
 * `public/` folder, so any site origin serves them). */
export function logoUrls(siteUrl: string): { wordmark: string; mark: string } {
  const base = trimUrl(siteUrl);
  return { wordmark: `${base}${LOGO_WORDMARK_PATH}`, mark: `${base}${LOGO_MARK_PATH}` };
}

/** Score → accent colour, matched to the grading tiers (green ≥7, amber ≥5,
 * red below). Kept in lockstep with the app's tier bands. */
export function emailScoreColor(score: number): string {
  if (score >= 7) return "#16A34A";
  if (score >= 5) return "#CA8A04";
  return "#DC2626";
}

/** Light tint + border partner for a score, for the gauge fill panel + chips. */
function scoreTintPair(score: number): { tint: string; ring: string; chipBg: string; chipFg: string; chipBorder: string } {
  if (score >= 7) {
    return { tint: "#EAF7EF", ring: "#16A34A", chipBg: "rgba(22,163,74,0.12)", chipFg: "#15803D", chipBorder: "rgba(22,163,74,0.30)" };
  }
  if (score >= 5) {
    return { tint: "#FBF4E4", ring: "#CA8A04", chipBg: "rgba(202,138,4,0.14)", chipFg: "#A16207", chipBorder: "rgba(202,138,4,0.35)" };
  }
  return { tint: "#FCEBEB", ring: "#DC2626", chipBg: "rgba(220,38,38,0.12)", chipFg: "#B91C1C", chipBorder: "rgba(220,38,38,0.30)" };
}

// ── Header ────────────────────────────────────────────────────────────────────

export interface EmailHeaderOptions {
  siteUrl: string;
  tagline?: string;
  /** Absolute logo URL override (defaults to `${siteUrl}/logo_white.png`). */
  logoUrl?: string;
  /** Extra class on the padded <td> (Engine B passes "gt-pad" for mobile). */
  tdClass?: string;
}

/**
 * The navy gradient header with the real wordmark logo and a red hairline
 * accent bar. Returns table `<tr>`s (two: the header + the 3px accent). The
 * logo `<img>` carries explicit width/height + alt so it degrades to styled
 * alt text when images are blocked.
 */
export function emailHeaderRows(opts: EmailHeaderOptions): string {
  const { navy, navyLight, navyDeep, red, redLight } = EMAIL_BRAND;
  const tagline = opts.tagline ?? DEFAULT_TAGLINE;
  const logo = opts.logoUrl ?? logoUrls(opts.siteUrl).wordmark;
  const cls = opts.tdClass ? ` class="${opts.tdClass}"` : "";
  return `<tr>
      <td${cls} bgcolor="${navy}" style="background-color:${navy};background-image:linear-gradient(135deg,${navyLight} 0%,${navy} 45%,${navyDeep} 100%);padding:28px 34px 24px;border-radius:14px 14px 0 0;text-align:center;">
        <img src="${esc(logo)}" alt="GradeThread" width="154" height="32" style="height:32px;width:154px;display:block;margin:0 auto;border:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;" />
        <p style="margin:14px 0 0;color:rgba(255,255,255,0.62);font-size:12px;line-height:1;letter-spacing:1.6px;text-transform:uppercase;font-weight:600;">${esc(tagline)}</p>
      </td>
    </tr>
    <tr>
      <td bgcolor="${red}" style="background-color:${red};background-image:linear-gradient(90deg,${red} 0%,${redLight} 50%,${red} 100%);height:3px;line-height:3px;font-size:0;">&nbsp;</td>
    </tr>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────

export interface EmailSocialLink {
  label: string; // short glyph/text shown in the chip (e.g. "IG", "X", "TT")
  url: string; // absolute
}

/** GradeThread's canonical social accounts — shown in every email footer
 * (transactional + marketing) so the row stays consistent across both engines. */
export const GRADETHREAD_SOCIAL_LINKS: EmailSocialLink[] = [
  { label: "IG", url: "https://www.instagram.com/gradethreadapp/" },
  { label: "TT", url: "https://www.tiktok.com/@grade.thread" },
  { label: "X", url: "https://x.com/GradeThread" },
  { label: "f", url: "https://www.facebook.com/GradeThread" },
];

export interface EmailFooterOptions {
  siteUrl: string;
  year: number;
  postalAddress?: string;
  unsubscribeUrl?: string;
  preferenceCenterUrl?: string;
  /** Label for the unsubscribe link (differs: marketing vs newsletter copy). */
  unsubscribeLabel?: string;
  /** Absolute mark/icon URL override (defaults to `${siteUrl}/logo_icon.png`). */
  markUrl?: string;
  /** Optional social chips. Omitted entirely when empty. */
  social?: EmailSocialLink[];
  tdClass?: string;
}

/**
 * The night-ground footer: icon mark, optional social row, site + help links,
 * copyright, postal address (CAN-SPAM), and — for marketing mail — the
 * one-click unsubscribe + preference-center links. Returns table `<tr>`s.
 */
export function emailFooterRows(opts: EmailFooterOptions): string {
  const { night } = EMAIL_BRAND;
  const site = trimUrl(opts.siteUrl);
  const mark = opts.markUrl ?? logoUrls(opts.siteUrl).mark;
  const cls = opts.tdClass ? ` class="${opts.tdClass}"` : "";

  const social = (opts.social ?? []).filter((s) => s.url && s.label);
  const socialRow = social.length
    ? `<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:14px auto 4px;"><tr>${
      social
        .map(
          (s) =>
            `<td style="padding:0 4px;"><a href="${esc(s.url)}" style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;background-color:rgba(255,255,255,0.08);border-radius:8px;color:rgba(255,255,255,0.72);font-size:12px;font-weight:700;text-decoration:none;">${esc(s.label)}</a></td>`,
        )
        .join("")
    }</tr></table>`
    : "";

  const postal = opts.postalAddress
    ? `<p style="margin:8px 0 0;color:rgba(255,255,255,0.40);font-size:11px;line-height:1.5;">${esc(opts.postalAddress)}</p>`
    : "";

  const prefLink = opts.preferenceCenterUrl
    ? ` &nbsp;&middot;&nbsp; <a href="${esc(opts.preferenceCenterUrl)}" style="color:#9aa4b8;font-size:12px;text-decoration:underline;">Manage email preferences</a>`
    : "";
  const unsubscribeRow = opts.unsubscribeUrl
    ? `<tr>
        <td${cls} style="padding:14px 32px 0;text-align:center;">
          <a href="${esc(opts.unsubscribeUrl)}" style="color:#9aa4b8;font-size:12px;text-decoration:underline;">${esc(opts.unsubscribeLabel ?? "Unsubscribe")}</a>${prefLink}
        </td>
      </tr>`
    : "";

  return `<tr>
      <td${cls} bgcolor="${night}" style="background-color:${night};padding:26px 34px;border-radius:0 0 14px 14px;text-align:center;">
        <img src="${esc(mark)}" alt="GradeThread" width="34" height="34" style="width:34px;height:34px;display:inline-block;border:0;border-radius:9px;" />
        ${socialRow}
        <p style="margin:14px 0 0;color:rgba(255,255,255,0.55);font-size:12px;line-height:1.6;">
          <a href="${esc(site)}" style="color:rgba(255,255,255,0.78);text-decoration:none;">gradethread.com</a>
          &nbsp;&middot;&nbsp; <a href="${esc(site)}/help" style="color:rgba(255,255,255,0.78);text-decoration:none;">Help Center</a>
        </p>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.40);font-size:11px;line-height:1.5;">&copy; ${opts.year} Pearson Media LLC. All rights reserved.</p>
        ${postal}
      </td>
    </tr>
    ${unsubscribeRow}`;
}

// ── CTA button ────────────────────────────────────────────────────────────────

export type EmailButtonVariant = "primary" | "secondary";

/**
 * Bulletproof CTA button. A VML `<v:roundrect>` gives Outlook rounded corners +
 * the fill; every other client gets the styled anchor (gradient on primary,
 * outlined on secondary). `url` must already be absolute + (optionally)
 * tracking-wrapped by the caller.
 */
export function emailButton(
  label: string,
  url: string,
  opts: { variant?: EmailButtonVariant } = {},
): string {
  const { red, redLight, redDeep, navy } = EMAIL_BRAND;
  const href = esc(url);
  const text = esc(label);
  const secondary = opts.variant === "secondary";

  const msoFill = secondary ? "#ffffff" : red;
  const msoStroke = secondary ? "#D3DBE6" : red;
  const msoText = secondary ? navy : "#ffffff";

  const anchorStyle = secondary
    ? `background-color:#ffffff;border:1.5px solid #D3DBE6;border-radius:10px;color:${navy};display:inline-block;font-family:${EMAIL_FONT_STACK};font-size:15px;font-weight:700;line-height:45px;text-align:center;text-decoration:none;padding:0 38px;`
    : `background-color:${red};background-image:linear-gradient(180deg,${redLight} 0%,${red} 55%,${redDeep} 100%);border-radius:10px;color:#ffffff;display:inline-block;font-family:${EMAIL_FONT_STACK};font-size:15px;font-weight:700;line-height:48px;text-align:center;text-decoration:none;padding:0 40px;box-shadow:0 8px 20px -6px rgba(233,69,96,0.5);`;

  return `<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:6px auto 24px;">
    <tr>
      <td align="center">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="20%" strokecolor="${msoStroke}" fillcolor="${msoFill}">
          <w:anchorlock/>
          <center style="color:${msoText};font-family:Arial,sans-serif;font-size:15px;font-weight:700;">${text}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${href}" style="${anchorStyle}">${text}</a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
}

// ── Score card ────────────────────────────────────────────────────────────────

/** A grade tier as a semantic pill — colour encodes condition at a glance. */
export function emailTierChip(tier: string, score: number): string {
  const c = scoreTintPair(score);
  return `<span style="display:inline-block;background-color:${c.chipBg};color:${c.chipFg};border:1px solid ${c.chipBorder};font-size:11px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;padding:5px 12px;border-radius:999px;font-family:${EMAIL_FONT_STACK};">${esc(tier)}</span>`;
}

/**
 * The hero score block for grade emails: a large colour-graded numeral inside a
 * rounded ring cell, beside a tier chip + condition summary. Table-based so it
 * holds together in Outlook (where the round ring degrades to a rounded square).
 */
export function emailScoreCard(opts: {
  score: number;
  tier: string;
  summary?: string;
}): string {
  const { ink, slate } = EMAIL_BRAND;
  const color = emailScoreColor(opts.score);
  const { tint, ring } = scoreTintPair(opts.score);
  const scoreStr = opts.score.toFixed(1);
  const summary = opts.summary
    ? `<div style="margin:8px 0 0;font-size:14px;color:${slate};line-height:1.5;">${esc(opts.summary)}</div>`
    : "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 24px;">
    <tr>
      <td style="background-color:#F7F9FC;background-image:linear-gradient(160deg,#F7F9FC 0%,#EEF2F8 100%);border:1px solid ${EMAIL_BRAND.hairline};border-radius:16px;padding:24px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td width="120" valign="middle" style="width:120px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="120" height="120" align="center" valign="middle" style="width:120px;height:120px;background-color:${tint};border:3px solid ${ring};border-radius:60px;">
                    <span style="font-size:40px;font-weight:800;color:${color};line-height:1;font-family:${EMAIL_FONT_STACK};">${scoreStr}<span style="font-size:15px;color:#8A94A8;font-weight:700;">/10</span></span>
                  </td>
                </tr>
              </table>
            </td>
            <td valign="middle" style="padding-left:22px;">
              ${emailTierChip(opts.tier, opts.score)}
              <div style="margin:10px 0 0;font-size:15px;color:${ink};line-height:1.4;font-weight:600;font-family:${EMAIL_FONT_STACK};">on the GradeThread 1.0&ndash;10.0 condition scale</div>
              ${summary}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

// ── Certificate card ──────────────────────────────────────────────────────────

/**
 * A navy-capped certificate card with the public cert id and (optional)
 * thumbnail. Reused across grade-complete / finalized / dispute emails. `certUrl`
 * must be absolute.
 */
export function emailCertificateCard(opts: {
  certId: string;
  certUrl: string;
  title: string;
  subtitle: string;
  thumbUrl?: string;
}): string {
  const { navy, navyDeep, ink, slate, hairline } = EMAIL_BRAND;
  const thumb = opts.thumbUrl
    ? `<td width="64" valign="middle" style="width:64px;"><img src="${esc(opts.thumbUrl)}" alt="" width="64" height="64" style="width:64px;height:64px;border-radius:10px;display:block;border:0;" /></td>`
    : "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 24px;border:1px solid ${hairline};border-radius:14px;overflow:hidden;">
    <tr>
      <td bgcolor="${navy}" style="background-color:${navy};background-image:linear-gradient(135deg,${navy},${navyDeep});padding:14px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="color:rgba(255,255,255,0.72);font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;font-family:${EMAIL_FONT_STACK};">Verified Certificate</td>
          <td align="right" style="color:#ffffff;font-size:13px;font-weight:700;font-family:${EMAIL_MONO_STACK};">#${esc(opts.certId)}</td>
        </tr></table>
      </td>
    </tr>
    <tr>
      <td style="background-color:#ffffff;padding:18px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          ${thumb}
          <td valign="middle" style="${opts.thumbUrl ? "padding-left:16px;" : ""}">
            <a href="${esc(opts.certUrl)}" style="margin:0;font-size:15px;font-weight:700;color:${ink};text-decoration:none;font-family:${EMAIL_FONT_STACK};">${esc(opts.title)}</a>
            <div style="margin:4px 0 0;font-size:13px;color:${slate};line-height:1.5;">${esc(opts.subtitle)}</div>
          </td>
        </tr></table>
      </td>
    </tr>
  </table>`;
}

// ── Divider ───────────────────────────────────────────────────────────────────

export function emailDividerRow(): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
    <tr><td style="border-top:1px solid ${EMAIL_BRAND.hairline};font-size:0;line-height:0;">&nbsp;</td></tr>
  </table>`;
}

// ── Shared <head> fragments (MSO + dark-mode) ─────────────────────────────────

/** The MSO conditional + progressive-enhancement <style> both engines drop in
 * their document <head> for Outlook rendering + dark-mode + responsive. */
export function emailHeadStyle(): string {
  const { night } = EMAIL_BRAND;
  return `<!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>*{font-family:Arial,Helvetica,sans-serif !important;}</style>
  <![endif]-->
  <style>
    /* Progressive enhancement only — the layout is fully inline and renders
       correctly with this block stripped. */
    @media (prefers-color-scheme: dark) {
      .gt-body { background-color:${night} !important; }
      .gt-card { background-color:#1F2540 !important; }
      .gt-text { color:#D8DCE6 !important; }
      .gt-heading { color:#ffffff !important; }
    }
    @media screen and (max-width: 600px) {
      .gt-container { width:100% !important; }
      .gt-pad { padding-left:22px !important; padding-right:22px !important; }
    }
    a { text-decoration:none; }
  </style>`;
}

/** Canvas background colour for the outer body (navy-biased, not flat grey). */
export const EMAIL_CANVAS = EMAIL_BRAND.canvas;
