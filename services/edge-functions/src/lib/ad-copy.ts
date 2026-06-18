// US-1073: pure ad-copy helpers — char-limit/policy guardrails, normalization,
// and CSV / Google Ads Editor export formatting.
//
// This module is PURE and dependency-free (no AI client, no DB) so the
// guardrails and export formatting are unit-tested without any network calls.
// The AI orchestration lives in ad-copy-ai.ts; the route in routes/admin-ads.ts.

export type AdPlatform = "google_ads" | "apple_search_ads";

// ── Platform limits (Google Ads RSA + Apple Search Ads) ────────────────
// Google responsive search ads: up to 15 headlines (≤30 chars) + 4 descriptions
// (≤90 chars). Apple Search Ads keywords are short single terms/phrases; custom
// product page "creative" lines are kept short and punchy.
export const AD_LIMITS = {
  google_ads: {
    headlineMaxChars: 30,
    headlineMax: 15,
    descriptionMaxChars: 90,
    descriptionMax: 4,
  },
  apple_search_ads: {
    keywordMaxChars: 28,
    keywordMax: 50,
    creativeMaxChars: 45,
    creativeMax: 6,
  },
} as const;

export interface AdLine {
  text: string;
  chars: number;
}

export interface GoogleAdsPayload {
  headlines: AdLine[];
  descriptions: AdLine[];
}

export interface AppleSearchAdsPayload {
  keywords: { exact: string[]; broad: string[] };
  creative: AdLine[];
}

export type AdPayload = GoogleAdsPayload | AppleSearchAdsPayload;

// Disallowed policy patterns: superlatives that breach Google's "no unverifiable
// claims" + ALL-CAPS / excess punctuation that breaches editorial policy. Lines
// matching these are rejected by the guardrail so they never reach the operator.
const BANNED_PATTERNS: RegExp[] = [
  // "#1" has no leading word boundary (# is non-word), so match it literally.
  /#\s?1\b/,
  /\b(?:number one|best ever|guaranteed)\b/i,
  /!{2,}/, // repeated exclamation marks
  /\?{2,}/,
];

// A line is ALL CAPS (policy breach) when it has ≥2 letters and no lowercase.
function isShouting(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, "");
  return letters.length >= 2 && letters === letters.toUpperCase();
}

export function violatesPolicy(text: string): boolean {
  if (isShouting(text)) return true;
  return BANNED_PATTERNS.some((re) => re.test(text));
}

// Collapse whitespace, trim, and drop wrapping quotes the model sometimes adds.
export function normalizeLine(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
}

// Filter a list of candidate lines to those within the char limit, free of
// policy violations, non-empty, and de-duplicated (case-insensitive). Returns at
// most `max` lines, each tagged with its character count.
export function enforceLines(
  candidates: unknown[],
  maxChars: number,
  max: number,
): AdLine[] {
  const out: AdLine[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = normalizeLine(raw);
    if (!text) continue;
    if (text.length > maxChars) continue;
    if (violatesPolicy(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, chars: text.length });
    if (out.length >= max) break;
  }
  return out;
}

// Normalize + de-dupe a list of ASA keyword terms within the per-term limit.
export function enforceKeywords(
  candidates: unknown[],
  maxChars: number,
  max: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = normalizeLine(raw).toLowerCase();
    if (!text) continue;
    if (text.length > maxChars) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// ── Export formatting ──────────────────────────────────────────────────

function csvCell(value: string): string {
  // RFC-4180 quoting: wrap in quotes and double embedded quotes when the cell
  // contains a comma, quote, or newline.
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// Generic CSV export (one row per asset) — works for both platforms and is the
// easy "open in a spreadsheet" format.
export function adCreativeToCsv(
  platform: AdPlatform,
  payload: AdPayload,
  sourceKeywords: string[],
): string {
  const tag = sourceKeywords.join(" | ");
  const rows: string[][] = [["platform", "asset_type", "text", "chars", "source_keywords"]];
  if (platform === "google_ads") {
    const p = payload as GoogleAdsPayload;
    for (const h of p.headlines) {
      rows.push([platform, "headline", h.text, String(h.chars), tag]);
    }
    for (const d of p.descriptions) {
      rows.push([platform, "description", d.text, String(d.chars), tag]);
    }
  } else {
    const p = payload as AppleSearchAdsPayload;
    for (const k of p.keywords.exact) {
      rows.push([platform, "keyword_exact", k, String(k.length), tag]);
    }
    for (const k of p.keywords.broad) {
      rows.push([platform, "keyword_broad", k, String(k.length), tag]);
    }
    for (const c of p.creative) {
      rows.push([platform, "creative", c.text, String(c.chars), tag]);
    }
  }
  return toCsv(rows);
}

// Google Ads Editor bulk-upload CSV: one row per RSA with Headline 1..15 +
// Description 1..4 columns, which Ads Editor imports directly. ASA has no Ads
// Editor equivalent, so we fall back to the generic CSV.
export function adCreativeToAdsEditorCsv(
  platform: AdPlatform,
  payload: AdPayload,
): string {
  if (platform !== "google_ads") {
    return adCreativeToCsv(platform, payload, []);
  }
  const p = payload as GoogleAdsPayload;
  const headers: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < AD_LIMITS.google_ads.headlineMax; i++) {
    headers.push(`Headline ${i + 1}`);
    values.push(p.headlines[i]?.text ?? "");
  }
  for (let i = 0; i < AD_LIMITS.google_ads.descriptionMax; i++) {
    headers.push(`Description ${i + 1}`);
    values.push(p.descriptions[i]?.text ?? "");
  }
  return toCsv([headers, values]);
}
