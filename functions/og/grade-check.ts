// US-1752: shareable card for a free grade-checker result.
//
// /og/grade-check?g=&tier=&brand=&item=&vlo=&vhi=&cur= returns an on-brand
// 1200x630 PNG (Satori via workers-og). It is STATELESS — every value rides in
// the query string — so it exposes no stored result, carries NO PII (only the
// grade, tier, an aggregate value RANGE, and the brand/item the sharer typed),
// renders deterministically, and edge-caches on the full URL. The card's QR
// points back at the free tool so a share pulls new visitors into the funnel.

import { ImageResponse } from "workers-og";
import {
  brandedFallbackResponse,
  buildGradeResultCardHtml,
  renderOgImage,
} from "../_shared/og-template";
import { siteUrl, type PagesEnv } from "../_shared/blog-render";
import { qrSvgDataUri } from "../_shared/qr";

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const CARD_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

// Minimal currency-symbol map; unknown currencies fall back to the ISO code.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "$",
  AUD: "$",
  GBP: "£",
  EUR: "€",
};

/** Clamp a query value to a finite grade in [1, 10]; default 5 if unparseable. */
function parseScore(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, n));
}

/** Parse a whole-dollar amount ≥ 0, or null. */
function parseDollars(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** "$15 – $26" from a low/high dollar range, or null when either side is absent. */
function formatValueText(
  lo: number | null,
  hi: number | null,
  currency: string,
): string | null {
  if (lo == null || hi == null) return null;
  const sym = CURRENCY_SYMBOLS[currency] ?? "";
  const fmt = (n: number) =>
    sym ? `${sym}${n.toLocaleString("en-US")}` : `${n.toLocaleString("en-US")} ${currency}`;
  return `${fmt(lo)} – ${fmt(hi)}`;
}

export const onRequestGet: PagesFunction<PagesEnv> = async (context) => {
  const url = new URL(context.request.url);
  const q = url.searchParams;

  const score = parseScore(q.get("g"));
  const gradeTier = (q.get("tier") ?? "").trim().slice(0, 40) || "Estimate";
  const brand = (q.get("brand") ?? "").trim().slice(0, 40) || null;
  const itemLabel = (q.get("item") ?? "").trim().slice(0, 40) || null;
  const currency = ((q.get("cur") ?? "USD").trim().toUpperCase().slice(0, 3)) || "USD";
  const valueText = formatValueText(
    parseDollars(q.get("vlo")),
    parseDollars(q.get("vhi")),
    currency,
  );

  // QR → the free tool on this same origin, tagged so a scanned share is
  // attributable to the share-card channel.
  const toolUrl = `${url.origin}/tools/grade-checker?utm_source=share-card&utm_medium=qr`;

  try {
    const html = buildGradeResultCardHtml({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      score,
      gradeTier,
      brand,
      itemLabel,
      valueText,
      qrDataUri: qrSvgDataUri(toolUrl, { ecl: "M" }),
    });
    // US-2619: this one WORKS in production (134022 real bytes) and is buffered
    // anyway, for the zero-byte guard rather than the fix. All four in-Function
    // OG endpoints now fail the same way, which matters more than leaving the
    // healthy one different: the next person reading any of them finds the same
    // shape, and a silent empty render here would be as invisible as it was on
    // the social card.
    return await renderOgImage(
      () => new ImageResponse(html, { width: CARD_WIDTH, height: CARD_HEIGHT }),
      { "Cache-Control": CARD_CACHE_CONTROL },
    );
  } catch (err) {
    console.error("[og/grade-check] render failed:", err);
    // US-2108 AC3: branded card rather than a blank preview.
    return await brandedFallbackResponse(siteUrl(context.env));
  }
};
