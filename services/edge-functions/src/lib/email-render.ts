// US-919: Email-safe modular HTML rendering engine.
//
// Pure + dependency-light (string/data in → string out; no supabase / env /
// network) so it is unit-testable and reusable from the marketing newsletter,
// lifecycle journeys (US-929), and the trial-conversion drip (US-938). It turns a
// structured `EmailDocument` — or a legacy newsletter issue via the bridge below
// — into bulletproof, client-safe HTML using branded, table-based, inline-CSS
// components, REPLACING reliance on the minimal `emailLayout` for marketing mail.
//
// Email-client constraints honoured (AC2):
//   • ALL base layout CSS is INLINE — the email is fully functional with the
//     <head> <style> block stripped (it carries only the dark-mode + responsive
//     progressive-enhancement layer, never anything the layout relies on).
//   • MSO conditional comments: an Outlook ghost-table wraps the 600px container
//     and every CTA renders a VML <v:roundrect> button (rounded corners in
//     Outlook, which ignores border-radius).
//   • max-width 600px, fluid/responsive (a `max-width:600px` < 100% container).
//   • prefers-color-scheme dark handling via `color-scheme` meta + a media query.
//   • web-safe Inter-fallback font stack (Outlook falls back to Arial).
//
// Compliance + deliverability (AC3/AC4):
//   • every <img> carries alt text + explicit width/height + a brand bg colour
//     (so a blocked image shows a coloured box + the alt copy, not a broken icon);
//   • every link is made absolute (relative URLs are resolved against the site
//     origin) and — when `tracking` is supplied — wrapped by the click-tracker at
//     render time, plus a hidden open pixel is injected;
//   • the CAN-SPAM footer (postal address) + preference-center + one-click
//     unsubscribe are always rendered when their URLs are supplied, and the
//     resolved unsubscribe URL is returned for the SMTP List-Unsubscribe header.
//
// `renderEmailText()` auto-generates the plaintext multipart alternative.

import { applyEmailTracking, rewriteLinksForClickTracking } from "./email-tracking.ts";
import type { RenderableIssue, RenderOptions } from "./newsletter-issue.ts";
import {
  EMAIL_BRAND,
  emailButton,
  emailFooterRows,
  emailHeaderRows,
  GRADETHREAD_SOCIAL_LINKS,
} from "./email-theme.ts";

// ── Brand palette + typography ────────────────────────────────────────────────

const BRAND_NAVY = EMAIL_BRAND.navy;
const BRAND_RED = EMAIL_BRAND.red;
const BRAND_NIGHT = EMAIL_BRAND.night;
const BRAND_GRAY = "#F5F5F5";
const TEXT_DARK = "#333333";

// Web-safe stack: Inter where the client supports a web/system font, otherwise
// graceful fallbacks. Outlook is forced to Arial via the MSO <style> in the head.
const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const DEFAULT_SITE_URL = "https://gradethread.com";
const DEFAULT_TAGLINE = "AI-Powered Clothing Condition Grading";
const CONTENT_WIDTH = 600;
// Usable content width inside the 32px-padded white card (retina sources are
// generated larger then bounded to this in the markup).
const CONTENT_INNER_WIDTH = CONTENT_WIDTH - 64;

// ── Escaping + URL helpers (pure) ─────────────────────────────────────────────

/** Escape the dangerous five for safe interpolation into HTML / attributes. */
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An absolute http(s)/mailto/tel URL — never relative. */
export function isAbsoluteUrl(url: string): boolean {
  const u = (url ?? "").trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(u);
}

/**
 * Make a link absolute. Absolute (http/https/mailto/tel) and protocol-relative
 * URLs pass through; anything else is joined onto the site origin so no relative
 * URL ever survives into the email (AC4 / the QA gate's `links_absolute` check).
 */
export function absolutizeUrl(url: string, siteUrl: string = DEFAULT_SITE_URL): string {
  const u = (url ?? "").trim();
  if (!u) return u;
  if (isAbsoluteUrl(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  const base = siteUrl.replace(/\/+$/, "");
  return u.startsWith("/") ? `${base}${u}` : `${base}/${u}`;
}

// ── Document model ────────────────────────────────────────────────────────────

export interface EmailImage {
  url: string;
  alt: string;
  /** Intrinsic source width/height — used to derive email-safe width/height attrs. */
  width: number;
  height: number;
}

export interface EmailCta {
  label: string;
  url: string;
}

/** A branded, reusable content block. The same set powers marketing, lifecycle,
 * and drip emails (AC6). */
export type EmailBlock =
  | { kind: "hero"; image: EmailImage; eyebrow?: string; headline?: string; subtext?: string }
  | { kind: "article"; heading?: string; bodyHtml: string; image?: EmailImage; cta?: EmailCta }
  | { kind: "tip"; heading?: string; bodyHtml: string }
  | { kind: "cta"; label: string; url: string }
  | { kind: "divider" }
  | { kind: "text"; heading?: string; bodyHtml: string };

export interface EmailDocument {
  subject: string;
  preheader?: string | null;
  blocks: EmailBlock[];
}

export interface EmailRenderOptions {
  siteUrl?: string;
  year?: number;
  /** Optional absolute logo URL (else the text wordmark is used). */
  logoUrl?: string;
  tagline?: string;
  /** One-click, no-login CAN-SPAM unsubscribe link. */
  unsubscribeUrl?: string;
  /** Manage-cadence/topics preference-center link. */
  preferenceCenterUrl?: string;
  /** CAN-SPAM physical postal address. */
  postalAddress?: string;
  /** Render-time click-tracking + open pixel (US-913). */
  tracking?: { baseUrl: string; token: string };
}

export interface RenderedEmail {
  html: string;
  text: string;
  /** The resolved unsubscribe URL, for the SMTP List-Unsubscribe header. */
  unsubscribeUrl?: string;
}

// ── Reusable, inline-CSS branded components (pure) ─────────────────────────────

/** Email-safe <img>: bounded to the content column, explicit attrs, alt text, and
 * a brand bg so a blocked image still shows a coloured box + the alt copy. */
export function renderEmailImage(image: EmailImage, opts: { maxWidth?: number } = {}): string {
  const maxW = opts.maxWidth ?? CONTENT_INNER_WIDTH;
  const ratio = image.height > 0 && image.width > 0 ? image.height / image.width : 0.625;
  const displayH = Math.round(maxW * ratio);
  return (
    `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" ` +
    `width="${maxW}" height="${displayH}" ` +
    `style="display:block;width:100%;max-width:${maxW}px;height:auto;border:0;` +
    `border-radius:8px;margin:0 0 20px;background-color:${BRAND_NAVY};color:${BRAND_GRAY};` +
    `font-size:13px;line-height:1.5;text-align:center;" />`
  );
}

/** Branded header: navy bar with the GradeThread wordmark (or a logo image) + a
 * tagline. Returns a table row. */
export function renderHeader(
  opts: { logoUrl?: string; tagline?: string; siteUrl?: string } = {},
): string {
  // Delegate to the shared brand system (email-theme) so the marketing engine
  // and the transactional engine (email.ts) render an identical header.
  return emailHeaderRows({
    siteUrl: opts.siteUrl ?? DEFAULT_SITE_URL,
    tagline: opts.tagline ?? DEFAULT_TAGLINE,
    logoUrl: opts.logoUrl && isAbsoluteUrl(opts.logoUrl) ? opts.logoUrl : undefined,
    tdClass: "gt-pad",
  });
}

/** Bulletproof CTA button (shared with the transactional engine): a VML
 * <v:roundrect> for Outlook + a gradient anchor everywhere else. Pure; `url`
 * must already be absolute + (optionally) tracking-wrapped by the caller. */
export function renderCtaButton(label: string, url: string): string {
  return emailButton(label, url);
}

/** An article-card content block: optional heading + image + body HTML + CTA. */
export function renderArticleCard(block: {
  heading?: string;
  bodyHtml: string;
  image?: EmailImage;
  cta?: EmailCta;
}): string {
  const heading = block.heading
    ? `<h2 class="gt-heading" style="margin:0 0 10px;color:${BRAND_NIGHT};font-size:19px;font-weight:700;line-height:1.3;">${escapeHtml(block.heading)}</h2>`
    : "";
  const image = block.image ? renderEmailImage(block.image) : "";
  const body = `<div class="gt-text" style="margin:0;color:${TEXT_DARK};font-size:15px;line-height:1.6;">${block.bodyHtml ?? ""}</div>`;
  const cta = block.cta?.label && block.cta?.url ? renderCtaButton(block.cta.label, block.cta.url) : "";
  return `<div style="margin:0 0 24px;">${heading}${image}${body}${cta}</div>`;
}

/** A tip / callout block: left-accent bordered panel on a tinted background. */
export function renderTipCallout(block: { heading?: string; bodyHtml: string }): string {
  const heading = block.heading
    ? `<p class="gt-heading" style="margin:0 0 6px;color:${BRAND_NAVY};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(block.heading)}</p>`
    : "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
    <tr>
      <td class="gt-card" bgcolor="${BRAND_GRAY}" style="background-color:${BRAND_GRAY};border-left:4px solid ${BRAND_RED};border-radius:6px;padding:16px 20px;">
        ${heading}
        <div class="gt-text" style="margin:0;color:${TEXT_DARK};font-size:14px;line-height:1.6;">${block.bodyHtml ?? ""}</div>
      </td>
    </tr>
  </table>`;
}

/** A full-bleed hero block: lead image + optional eyebrow/headline/subtext. */
export function renderHero(block: {
  image: EmailImage;
  eyebrow?: string;
  headline?: string;
  subtext?: string;
}): string {
  const eyebrow = block.eyebrow
    ? `<p style="margin:0 0 6px;color:${BRAND_RED};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(block.eyebrow)}</p>`
    : "";
  const headline = block.headline
    ? `<h1 class="gt-heading" style="margin:0 0 8px;color:${BRAND_NIGHT};font-size:24px;font-weight:700;line-height:1.25;">${escapeHtml(block.headline)}</h1>`
    : "";
  const subtext = block.subtext
    ? `<p class="gt-text" style="margin:0;color:${TEXT_DARK};font-size:15px;line-height:1.6;">${escapeHtml(block.subtext)}</p>`
    : "";
  const caption = eyebrow || headline || subtext
    ? `<div style="margin:0 0 24px;">${eyebrow}${headline}${subtext}</div>`
    : "";
  return `${renderEmailImage(block.image)}${caption}`;
}

/** A horizontal divider. */
export function renderDivider(): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
    <tr><td style="border-top:1px solid #e5e5ea;font-size:0;line-height:0;">&nbsp;</td></tr>
  </table>`;
}

/** Branded footer: copyright + site link + (when supplied) postal address,
 * preference-center, and the one-click unsubscribe link. Returns table rows. */
export function renderFooter(opts: {
  siteUrl?: string;
  year?: number;
  postalAddress?: string;
  unsubscribeUrl?: string;
  preferenceCenterUrl?: string;
}): string {
  // Shared footer (email-theme). Newsletter keeps its own unsubscribe wording.
  return emailFooterRows({
    siteUrl: opts.siteUrl ?? DEFAULT_SITE_URL,
    year: opts.year ?? 2026,
    postalAddress: opts.postalAddress,
    unsubscribeUrl: opts.unsubscribeUrl,
    preferenceCenterUrl: opts.preferenceCenterUrl,
    unsubscribeLabel: "Unsubscribe from this newsletter",
    social: GRADETHREAD_SOCIAL_LINKS,
    tdClass: "gt-pad",
  });
}

// ── Block dispatch ────────────────────────────────────────────────────────────

function renderBlock(block: EmailBlock, siteUrl: string): string {
  switch (block.kind) {
    case "hero":
      return renderHero({
        image: normalizeImage(block.image, siteUrl),
        eyebrow: block.eyebrow,
        headline: block.headline,
        subtext: block.subtext,
      });
    case "article":
      return renderArticleCard({
        heading: block.heading,
        bodyHtml: block.bodyHtml,
        image: block.image ? normalizeImage(block.image, siteUrl) : undefined,
        cta: block.cta ? { label: block.cta.label, url: absolutizeUrl(block.cta.url, siteUrl) } : undefined,
      });
    case "tip":
      return renderTipCallout({ heading: block.heading, bodyHtml: block.bodyHtml });
    case "cta":
      return renderCtaButton(block.label, absolutizeUrl(block.url, siteUrl));
    case "divider":
      return renderDivider();
    case "text":
      return renderArticleCard({ heading: block.heading, bodyHtml: block.bodyHtml });
  }
}

function normalizeImage(image: EmailImage, siteUrl: string): EmailImage {
  return { ...image, url: absolutizeUrl(image.url, siteUrl), alt: image.alt || "GradeThread" };
}

// ── Plaintext (multipart alternative) ─────────────────────────────────────────

function htmlToText(html: string): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Auto-generate the plaintext alternative from the document (AC3). */
export function renderEmailText(doc: EmailDocument, opts: EmailRenderOptions = {}): string {
  const siteUrl = (opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
  const lines: string[] = [];
  if (doc.subject?.trim()) lines.push(doc.subject.trim());

  for (const block of doc.blocks ?? []) {
    switch (block.kind) {
      case "hero":
        if (block.headline) lines.push(`\n${block.headline.trim()}`);
        if (block.subtext) lines.push(htmlToText(block.subtext));
        break;
      case "article":
      case "text":
        if (block.heading) lines.push(`\n${block.heading.trim()}`);
        if (block.bodyHtml) lines.push(htmlToText(block.bodyHtml));
        if (block.kind === "article" && block.cta?.label && block.cta?.url) {
          lines.push(`${block.cta.label.trim()}: ${absolutizeUrl(block.cta.url, siteUrl)}`);
        }
        break;
      case "tip":
        if (block.heading) lines.push(`\n${block.heading.trim()}`);
        if (block.bodyHtml) lines.push(htmlToText(block.bodyHtml));
        break;
      case "cta":
        lines.push(`${block.label.trim()}: ${absolutizeUrl(block.url, siteUrl)}`);
        break;
      case "divider":
        lines.push("\n———");
        break;
    }
  }

  if (opts.postalAddress) lines.push(`\n${opts.postalAddress}`);
  if (opts.unsubscribeUrl) lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);
  if (opts.preferenceCenterUrl) lines.push(`Manage preferences: ${opts.preferenceCenterUrl}`);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── The document renderer ─────────────────────────────────────────────────────

/**
 * Render an `EmailDocument` to a complete, send-ready, email-client-safe HTML
 * document plus its plaintext alternative. The HTML is fully self-contained: the
 * marketing coordinator / SMTP layer is handed `html` directly.
 */
export function renderEmailDocument(doc: EmailDocument, opts: EmailRenderOptions = {}): RenderedEmail {
  const siteUrl = (opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
  const year = opts.year ?? 2026;

  const preheader = doc.preheader && doc.preheader.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;font-size:1px;line-height:1px;color:${BRAND_GRAY};">${escapeHtml(doc.preheader)}</div>` +
      // Spacer entities push real content out of the preview line.
      `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${"&#847;&zwnj;&nbsp;".repeat(20)}</div>`
    : "";

  const content = (doc.blocks ?? []).map((b) => renderBlock(b, siteUrl)).join("");
  const header = renderHeader({ logoUrl: opts.logoUrl, tagline: opts.tagline, siteUrl });
  const footer = renderFooter({
    siteUrl,
    year,
    postalAddress: opts.postalAddress,
    unsubscribeUrl: opts.unsubscribeUrl,
    preferenceCenterUrl: opts.preferenceCenterUrl,
  });

  let html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(doc.subject ?? "")}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>*{font-family:Arial,Helvetica,sans-serif !important;}</style>
  <![endif]-->
  <style>
    /* Progressive enhancement ONLY — the layout above is fully inline and renders
       correctly with this block stripped (AC2: no <style>/JS reliance). */
    @media (prefers-color-scheme: dark) {
      .gt-body { background-color: ${BRAND_NIGHT} !important; }
      .gt-card { background-color: #222244 !important; }
      .gt-text { color: #e8e8f0 !important; }
      .gt-heading { color: #ffffff !important; }
    }
    @media screen and (max-width: 600px) {
      .gt-container { width: 100% !important; }
      .gt-pad { padding-left: 20px !important; padding-right: 20px !important; }
    }
  </style>
</head>
<body class="gt-body" style="margin:0;padding:0;background-color:${BRAND_GRAY};font-family:${FONT_STACK};">
  ${preheader}
  <!--[if mso]><table role="presentation" width="${CONTENT_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
  <table role="presentation" class="gt-body" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${BRAND_GRAY}" style="background-color:${BRAND_GRAY};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="gt-container" cellspacing="0" cellpadding="0" border="0" width="${CONTENT_WIDTH}" style="width:${CONTENT_WIDTH}px;max-width:${CONTENT_WIDTH}px;margin:0 auto;">
          ${header}
          <tr>
            <td class="gt-card gt-pad" bgcolor="#ffffff" style="background-color:#ffffff;padding:32px;">
              ${content}
            </td>
          </tr>
          ${footer}
        </table>
      </td>
    </tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
</body>
</html>`;

  // Render-time click-tracking: wrap every absolute link + inject the open pixel
  // (the unsubscribe + tracking endpoints are left direct — see email-tracking.ts).
  if (opts.tracking) {
    html = applyEmailTracking(html, opts.tracking.baseUrl, opts.tracking.token);
  }

  return {
    html,
    text: renderEmailText(doc, { ...opts, siteUrl }),
    unsubscribeUrl: opts.unsubscribeUrl,
  };
}

/** Wrap a single pre-rendered HTML fragment in the branded layout (for lifecycle
 * / drip steps that author their own inner content). Reuses the same components
 * so every email shares the look (AC6). */
export function renderEmailFragment(
  subject: string,
  contentHtml: string,
  opts: EmailRenderOptions = {},
): RenderedEmail {
  return renderEmailDocument(
    { subject, blocks: [{ kind: "article", bodyHtml: contentHtml }] },
    opts,
  );
}

// ── Bridge: legacy newsletter issue → EmailDocument ───────────────────────────

/**
 * Map a legacy `RenderableIssue` (subject/preheader/sections) onto the modular
 * block model. Each section becomes an article-card (heading + raw body HTML +
 * optional CTA). The autonomous newsletter pipeline already injects its lead
 * image as a section whose body is the email-safe <img>, so that flows through
 * verbatim. Pure.
 */
export function issueToEmailDocument(issue: RenderableIssue): EmailDocument {
  const blocks: EmailBlock[] = (issue.sections ?? []).map((s) => ({
    kind: "article" as const,
    heading: s.heading,
    bodyHtml: s.body ?? "",
    cta: s.ctaLabel && s.ctaUrl ? { label: s.ctaLabel, url: s.ctaUrl } : undefined,
  }));
  return { subject: issue.subject, preheader: issue.preheader, blocks };
}

function toRenderOptions(opts: RenderOptions): EmailRenderOptions {
  return {
    siteUrl: opts.siteUrl,
    year: opts.year,
    unsubscribeUrl: opts.unsubscribeUrl,
    preferenceCenterUrl: opts.preferenceCenterUrl,
    postalAddress: opts.postalAddress,
  };
}

/**
 * Back-compat entry point used by `renderNewsletterHtml`: render a newsletter
 * issue through the modular engine and return just the HTML string. Marketing
 * mail now flows through the bulletproof components instead of the minimal
 * layout (AC1).
 */
export function renderNewsletterEmail(issue: RenderableIssue, opts: RenderOptions = {}): string {
  return renderEmailDocument(issueToEmailDocument(issue), toRenderOptions(opts)).html;
}

/** Back-compat entry point used by `renderNewsletterText`. */
export function renderNewsletterEmailText(issue: RenderableIssue): string {
  return renderEmailText(issueToEmailDocument(issue));
}

// Re-exported so callers that already import the click rewriter from one place
// keep a single import surface.
export { applyEmailTracking, rewriteLinksForClickTracking };
