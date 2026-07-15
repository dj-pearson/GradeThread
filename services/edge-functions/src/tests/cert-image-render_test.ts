// Verifies the Deno-edge certificate image renderer (satori + resvg-wasm)
// produces valid PNGs — the replacement for the CPU-capped Cloudflare workers-og
// path that 503'd. og/badge/slab-label need no network (no hero fetch), so these
// run offline and deterministically.

import { assert, assertEquals } from "@std/assert";
import {
  type CertImageData,
  fetchImageDataUri,
  isSellerBadgeFormat,
  renderAchievementBadge,
  renderCertImage,
  renderSellerBadge,
  SELLER_BADGE_FORMATS,
  type SellerBadgeFormat,
} from "../lib/cert-image-render.ts";
import { buildAchievementBadgeHtml } from "../lib/cert-og-template.ts";

const DATA: CertImageData = {
  certId: "6d0d0f7a-23db-41f2-a891-5245e89eb504",
  title: "Moussy Vintage White Distressed Cropped Jeans",
  brand: "Moussy Vintage",
  score: 8.5,
  gradeTier: "Excellent",
  heroDataUri: null,
  certUrl: "https://gradethread.com/cert/6d0d0f7a-23db-41f2-a891-5245e89eb504?s=qr",
};

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 1000 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

Deno.test("renders a valid OG card PNG", async () => {
  assert(isPng(await renderCertImage("og", "square", DATA)));
});

Deno.test("US-1850: renders a valid achievement badge PNG", async () => {
  assert(
    isPng(
      await renderAchievementBadge({
        name: "Century",
        description: "Graded 100 items.",
        tier: "silver",
        earnedLabel: "Earned Jul 2026",
      }),
    ),
  );
});

Deno.test("US-1850: achievement badge template escapes + carries name/tier/description", () => {
  const html = buildAchievementBadgeHtml({
    width: 700,
    height: 180,
    name: "Viral <Find>",
    description: "A shared grade earned 10 verified clicks.",
    tier: "gold",
    earnedLabel: null,
  });
  assert(html.includes("Viral &lt;Find&gt;"), "name is HTML-escaped");
  assert(html.includes("verified clicks"), "description present");
  assert(html.includes("#d4af37"), "gold tier colour applied");
  assert(html.includes("GOLD"), "tier label present");
  assert(html.includes("GradeThread Achievement"), "brand line present");
  assert(!html.includes("<Find>"), "raw angle brackets never leak");
});

Deno.test("US-1850: an unknown tier falls back to the brand navy medal (no crash)", () => {
  const html = buildAchievementBadgeHtml({
    width: 700,
    height: 180,
    name: "Mystery",
    description: "Hidden badge.",
    tier: "platinum",
    earnedLabel: null,
  });
  assert(html.includes("700px"), "renders at the given width");
  assert(html.includes("PLATINUM"), "tier label still shown");
});

Deno.test("renders a valid badge PNG", async () => {
  assert(isPng(await renderCertImage("badge", "square", DATA)));
});

Deno.test("renders a valid label slab PNG (no hero)", async () => {
  assert(isPng(await renderCertImage("slab", "label", DATA)));
});

// US-1761: the verified-seller storefront badge renders at every format.
Deno.test("renders a valid seller badge PNG at every format", async () => {
  for (const fmt of Object.keys(SELLER_BADGE_FORMATS) as SellerBadgeFormat[]) {
    const png = await renderSellerBadge(fmt, {
      displayName: "Thrift King",
      totalGraded: 1000,
      totalIsCapped: true,
      averageGrade: 8.4,
    });
    assert(isPng(png), `format ${fmt} should render a PNG`);
  }
});

Deno.test("renders a seller badge with no grades yet (avg —)", async () => {
  assert(
    isPng(
      await renderSellerBadge("wide", {
        displayName: "New Seller",
        totalGraded: 0,
        totalIsCapped: false,
        averageGrade: 0,
      }),
    ),
  );
});

Deno.test("isSellerBadgeFormat guards the known formats", () => {
  assert(isSellerBadgeFormat("wide"));
  assert(isSellerBadgeFormat("compact"));
  assert(isSellerBadgeFormat("listing_header"));
  assert(!isSellerBadgeFormat("square"));
  assert(!isSellerBadgeFormat(null));
});

Deno.test("fetchImageDataUri returns null on empty/invalid input", async () => {
  assertEquals(await fetchImageDataUri(null), null);
  assertEquals(await fetchImageDataUri(""), null);
  // a data: URI is returned unchanged
  assertEquals(await fetchImageDataUri("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
});
