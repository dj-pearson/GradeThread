// US-913: signed open/click engagement tokens for marketing broadcast email.
//
// The growth-broadcast tracking endpoints (routes/email-engagement.ts) stamp
// campaign_recipients.opened_at / clicked_at. The link they carry must be:
//   • NON-ENUMERABLE — an attacker can't iterate recipients by guessing tokens.
//   • UNFORGEABLE — a recipient can't mint a token for ANOTHER recipient and
//     write to their row (so a token can never leak / affect another identity).
// We get both with an HMAC-signed, compact payload (campaign_id + user_id +
// kind, plus the destination URL for clicks) — JWT-shaped: `<bodyB64url>.<sigB64url>`.
// The click destination lives INSIDE the signed body, so the redirect target
// can't be tampered (no open-redirect) and needs no separate `?u=` parameter.
//
// This module is dependency-free (no supabase, no import-time env) so the signer,
// the rewriter, and their tests all run with no env dance. The signing SECRET is
// always passed in explicitly; `engagementSigningSecret()` (which reads Deno.env
// lazily, only when called) is the production resolver the route/sender use.

// Mounted at /api/email (a SIBLING of the admin auth group — email clients are
// unauthenticated). Shares the prefix with the SES-notification webhook; the
// paths (/o/:token, /c/:token vs /ses-notifications) don't collide.
export const EMAIL_TRACK_BASE_PATH = "/api/email";

export interface EngagementTokenPayload {
  /** campaign_id (growth_campaigns.id). */
  c: string;
  /** user_id (campaign_recipients.user_id). */
  u: string;
  /** kind: "o" = open pixel, "c" = click redirect. */
  k: "o" | "c";
  /** click destination URL (clicks only) — signed so it can't be tampered. */
  l?: string;
}

// ── base64url helpers ───────────────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function strToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

function base64UrlToStr(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s));
}

async function hmacSha256(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

// Constant-time string compare so a wrong signature can't be probed byte-by-byte.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Sign a payload into a `<body>.<sig>` token. */
export async function signEngagementToken(
  payload: EngagementTokenPayload,
  secret: string,
): Promise<string> {
  const body = strToBase64Url(JSON.stringify(payload));
  const sig = bytesToBase64Url(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}

/**
 * Verify + decode a token. Returns the payload only when the signature is valid
 * (so a tampered campaign/user/url, or a token minted without the secret, fails)
 * and the shape is well-formed; otherwise null.
 */
export async function verifyEngagementToken(
  token: string | null | undefined,
  secret: string,
): Promise<EngagementTokenPayload | null> {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = bytesToBase64Url(await hmacSha256(secret, body));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const obj = JSON.parse(base64UrlToStr(body)) as Record<string, unknown>;
    if (!obj || typeof obj.c !== "string" || typeof obj.u !== "string") return null;
    if (obj.k !== "o" && obj.k !== "c") return null;
    if (obj.k === "c" && typeof obj.l !== "string") return null;
    return obj as unknown as EngagementTokenPayload;
  } catch {
    return null;
  }
}

// ── bot-likely open detection ───────────────────────────────────────────────
// Mail proxies / privacy relays / security scanners prefetch images, which fires
// the open pixel without a human. We can't suppress those (the proxy IS the
// client), but where the User-Agent is detectable we FLAG the open so it can be
// discounted later. A missing/empty UA is treated as bot-likely (proxies often
// strip it). This is a flag only — the open is still recorded.
const BOT_OPEN_UA_RE =
  /(GoogleImageProxy|Google-Read-Aloud|YahooMailProxy|BingPreview|Microsoft Office|Outlook|Barracuda|Proofpoint|Mimecast|Cloudmark|Symantec|MessageLabs|facebookexternalhit|Slackbot|Twitterbot|TelegramBot|WhatsApp|LinkedInBot|bot\b|crawler|spider|preview|scanner|prefetch|fetch)/i;

export function isBotOpenUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim();
  if (!s) return true;
  return BOT_OPEN_UA_RE.test(s);
}

// ── link rewriter ───────────────────────────────────────────────────────────

// Links that must reach their real endpoint directly (never wrapped): the
// tracking endpoints themselves and the CAN-SPAM unsubscribe link — a one-click
// unsubscribe has to work even if the tracking redirect is down.
function isPassthroughLink(url: string): boolean {
  return url.includes(EMAIL_TRACK_BASE_PATH) ||
    /\/unsubscribe|\/api\/notifications\/unsubscribe/i.test(url);
}

export interface EngagementTrackingContext {
  campaignId: string;
  userId: string;
}

/**
 * Apply open + click tracking to fully-rendered marketing email HTML: rewrite
 * every http(s) `href` (except pass-through links) to a per-link signed click
 * redirect, then inject a hidden signed open pixel before </body>. Async because
 * each link is individually HMAC-signed.
 */
export async function applyMarketingEmailTracking(
  html: string,
  baseUrl: string,
  ctx: EngagementTrackingContext,
  secret: string,
): Promise<string> {
  const linkRe = /href="(https?:\/\/[^"]+)"/gi;

  // Sign one click token per UNIQUE destination (a precomputed map keeps the
  // actual replace() callback synchronous).
  const urls = new Set<string>();
  for (const m of html.matchAll(linkRe)) {
    const url = m[1];
    if (!isPassthroughLink(url)) urls.add(url);
  }
  const tokenByUrl = new Map<string, string>();
  for (const url of urls) {
    tokenByUrl.set(
      url,
      await signEngagementToken({ c: ctx.campaignId, u: ctx.userId, k: "c", l: url }, secret),
    );
  }

  let out = html.replace(linkRe, (whole, url: string) => {
    const tok = tokenByUrl.get(url);
    return tok ? `href="${baseUrl}${EMAIL_TRACK_BASE_PATH}/c/${tok}"` : whole;
  });

  const openTok = await signEngagementToken(
    { c: ctx.campaignId, u: ctx.userId, k: "o" },
    secret,
  );
  const pixel =
    `<img src="${baseUrl}${EMAIL_TRACK_BASE_PATH}/o/${openTok}" width="1" height="1" ` +
    `alt="" style="display:none;width:1px;height:1px" />`;
  out = /<\/body>/i.test(out)
    ? out.replace(/<\/body>/i, `${pixel}</body>`)
    : out + pixel;
  return out;
}

/**
 * Production signing-secret resolver. Reads Deno.env LAZILY (only when called),
 * so importing this module stays env-free for unit tests. Mirrors unsubscribe.ts:
 * a dedicated secret if set, else the always-present service-role key.
 */
export function engagementSigningSecret(): string {
  return (
    Deno.env.get("EMAIL_TRACKING_SECRET")?.trim() ||
    Deno.env.get("UNSUBSCRIBE_SECRET")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_KEY")?.trim() ||
    "dev-email-tracking-key"
  );
}
