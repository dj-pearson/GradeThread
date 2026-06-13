// US-598 — web barcode/UPC scan-to-autofill intake.
//
// Intake is FlipDesk's #1 bottleneck. iOS already scans barcodes (US-179); this
// is the web-side equivalent's server half: resolve a scanned code into product
// data the intake form can autofill.
//
// Two code shapes are handled:
//   1. UPC/EAN GTIN (8–14 digits) — pinned to the EXACT product via eBay Browse
//      (the same `gtin` search Scout's buy-decision mode uses, US-592). The
//      matched listing's title gives a suggested title, and detectBrandInText()
//      pulls a canonical brand off it.
//   2. Style/model code (sneakers/streetwear) — resolved by US-544's
//      resolveStyleCode() to a canonical brand + product aspects with no network
//      call; a best-effort comp query confirms a title.
//
// Light gate: confirms a valid FlipDesk account but requires NO paid feature —
// barcode autofill is available on every plan, and it returns product IDENTITY
// only (brand/title/style), never price comps (those stay behind the compPulls
// gate, US-619). Tenant-scoped is moot here — the lookup reads no tenant data.

import { Hono } from "hono";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import {
  canonicalizeBrand,
  detectBrandInText,
  resolveStyleCode,
} from "../lib/brand-normalize.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { recordMetric } from "../lib/observability.ts";

export const flipdeskProductRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// UPC-A/EAN-13/EAN-8/UPC-E digit barcodes (and ITF-14). Style codes go the other
// path, so anything all-digits in this length band is treated as a GTIN.
const GTIN_RE = /^\d{8,14}$/;

flipdeskProductRoutes.post("/lookup", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Confirm a valid account (applies plan fallback) but gate on no paid feature.
  const gate = await requireFlipdesk(c, { userId });
  if (gate) return gate;

  let body: { code?: unknown; categoryId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  if (!code) {
    return jsonError(c, 400, "code is required (a scanned UPC/EAN barcode or style code)");
  }
  if (code.length > 64) {
    return jsonError(c, 400, "code is too long");
  }

  const gtin = code.replace(/\s/g, "");
  const isGtin = GTIN_RE.test(gtin);

  // Style-code resolution (US-544) — pure, no network. Non-null for sneaker /
  // streetwear model codes; null for plain UPCs.
  const style = resolveStyleCode(code);

  let productTitle: string | null = null;
  let brandFromComp: string | null = null;
  let matchCount = 0;

  if (isGtin) {
    try {
      const search = await searchBrowseComps({
        gtin,
        categoryId: categoryId || undefined,
        limit: 10,
      });
      matchCount = search.items.length;
      productTitle = search.items.find((i) => i.title)?.title ?? null;
      brandFromComp = detectBrandInText(productTitle);
    } catch (err) {
      return failSafe(
        c,
        502,
        "Couldn't reach eBay to look up that barcode. Try again shortly.",
        err,
        "product.lookup",
      );
    }
  } else if (style) {
    // Best-effort title confirmation; style resolution alone still autofills.
    try {
      const search = await searchBrowseComps({
        q: style.compQuery,
        brand: style.brand,
        limit: 5,
      });
      matchCount = search.items.length;
      productTitle = search.items.find((i) => i.title)?.title ?? null;
    } catch {
      /* non-fatal */
    }
  } else {
    return jsonError(
      c,
      422,
      "That code isn't a recognizable UPC/EAN barcode or style code.",
    );
  }

  const brand = canonicalizeBrand(style?.brand ?? brandFromComp);
  const found = matchCount > 0 || style != null;

  recordMetric("product.lookup", 1, {
    found: String(found),
    kind: isGtin ? "gtin" : "style",
  });

  return c.json({
    found,
    code,
    // The scanned code is the natural SKU for intake.
    sku: code,
    brand,
    style: style?.styleCode ?? null,
    productTitle,
    // eBay item-specifics the style resolver inferred (Model/Department/Type).
    aspects: style?.aspects ?? null,
    matchCount,
    source: isGtin ? "gtin" : "style",
  });
});
