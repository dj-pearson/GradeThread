// Generates the 1200×630 social share images for GradeThread (US-427):
//   - public/og-image.png            site-wide default (links, certificates)
//   - public/social/<route>.png          distinct per-route images for high-value
//                                     marketing pages, with a route-specific
//                                     headline/subline (see ROUTE_CARDS below)
//
// Run on demand to regenerate after a brand/tagline change:
//   node scripts/generate-og-image.mjs
//
// @resvg/resvg-wasm (v2.x) cannot load custom fonts, so we vectorize every text
// run to SVG <path> data with opentype.js first. The resulting SVG has no font
// dependency, so the raster is deterministic and needs no headless browser. The
// brand wordmark is embedded as a base64 PNG so the mark is pixel-accurate.
//
// Font files differ per OS (Liberation Sans on the Linux build image, Arial on
// Windows/macOS dev boxes) — we resolve the first available candidate so this
// runs the same locally and in CI. Liberation Sans and Arial are metric-
// compatible, so layout is identical either way.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import opentype from "@shuding/opentype.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const NAVY = "#0F3460";
const NIGHT = "#1A1A2E";
const RED = "#E94560";
const SLATE = "#cbd5e1";

function firstExisting(paths, label) {
  const found = paths.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `[og-image] no ${label} font found. Tried:\n  ${paths.join("\n  ")}`,
    );
  }
  return found;
}

function loadFont(p) {
  const buf = readFileSync(p);
  return opentype.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

const bold = loadFont(
  firstExisting(
    [
      "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
      "C:/Windows/Fonts/arialbd.ttf",
      "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "bold",
  ),
);
const regular = loadFont(
  firstExisting(
    [
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "C:/Windows/Fonts/arial.ttf",
      "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
    "regular",
  ),
);

// Vectorize a text run to an SVG <path>. `anchor` "start" (x is left edge) or
// "middle" (x is the horizontal centre).
function textPath(font, text, x, baseline, size, fill, anchor = "start") {
  let drawX = x;
  if (anchor === "middle") {
    drawX = x - font.getAdvanceWidth(text, size) / 2;
  }
  const d = font.getPath(text, drawX, baseline, size).toPathData(2);
  return `<path d="${d}" fill="${fill}"/>`;
}

const logoB64 = readFileSync(resolve(root, "public/logo_white.png")).toString(
  "base64",
);

// 1200×630 (1.91:1) — the canonical Open Graph / Twitter summary_large_image size.
// `headline` is 1–2 lines (≤ ~24 chars/line at 60px), `subline` 1–2 lines.
// `badge`/`badgeLabel` fill the decorative top-right circle.
function buildSvg({ headline, subline, badge, badgeLabel }) {
  const h = headline;
  const s = subline;
  const headlineTags = h
    .map((line, i) => textPath(bold, line, 80, 360 + i * 74, 60, "#ffffff"))
    .join("\n  ");
  const sublineTags = s
    .map((line, i) => textPath(regular, line, 80, 520 + i * 40, 30, SLATE))
    .join("\n  ");
  // Underline sits just below the last headline line.
  const underlineY = 360 + (h.length - 1) * 74 + 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY}"/>
      <stop offset="1" stop-color="${NIGHT}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="14" height="630" fill="${RED}"/>

  <!-- Brand wordmark (white), intrinsic 1806×376 → scaled to 300 wide -->
  <image x="80" y="74" width="300" height="62" href="data:image/png;base64,${logoB64}"/>

  <!-- Decorative grade badge (top-right, clear of the headline) -->
  <circle cx="1040" cy="238" r="118" fill="${RED}" fill-opacity="0.10" stroke="${RED}" stroke-opacity="0.5" stroke-width="3"/>
  ${textPath(bold, badge, 1040, 272, 92, "#ffffff", "middle")}
  ${textPath(bold, badgeLabel, 1040, 322, 22, RED, "middle")}

  <!-- Headline -->
  ${headlineTags}
  <rect x="82" y="${underlineY}" width="150" height="8" rx="4" fill="${RED}"/>

  <!-- Subline -->
  ${sublineTags}

  ${textPath(bold, "gradethread.com", 80, 600, 26, RED)}
</svg>`;
}

// The site-wide default + one card per high-value marketing route. The `file`
// values MUST stay in sync with ROUTE_OG_IMAGES in src/lib/seo/public-routes.ts
// (enforced by src/lib/seo/__tests__/og-images.test.ts).
const DEFAULT_CARD = {
  file: "public/og-image.png",
  headline: ["The Standard for Clothing", "Condition Grading"],
  subline: [
    "Objective AI condition grades and verifiable",
    "certificates buyers trust.",
  ],
  badge: "9.5",
  badgeLabel: "EXCELLENT",
};

const ROUTE_CARDS = [
  {
    // US-9211: /flipdesk had no card of its own while five grading pages did,
    // so every share of the product page fell back to the site default. The
    // badge is deliberately kept — the grade is the differentiator ON the
    // product, which is the whole Path 7 decision.
    file: "public/social/flipdesk.png",
    headline: ["List Everywhere From", "One Place"],
    subline: [
      "Catalog, price, cross-list and reconcile —",
      "with a verifiable grade on every listing.",
    ],
    badge: "9.5",
    badgeLabel: "EXCELLENT",
  },
  {
    file: "public/social/how-it-works.png",
    headline: ["How GradeThread Grades", "Pre-Owned Clothing"],
    subline: [
      "Upload photos. Get a 1.0–10.0 condition",
      "grade across five weighted factors.",
    ],
    badge: "9.5",
    badgeLabel: "EXCELLENT",
  },
  {
    file: "public/social/pricing.png",
    headline: ["Simple, Transparent", "Grading Pricing"],
    subline: [
      "A free plan, pay-per-grade tiers, credit",
      "packs, and FlipDesk subscriptions.",
    ],
    badge: "9.5",
    badgeLabel: "EXCELLENT",
  },
  {
    file: "public/social/for-resellers.png",
    headline: ["Condition Grades That", "Build Buyer Trust"],
    subline: [
      "Cut returns and sell faster on eBay,",
      "Poshmark, Mercari, Depop & Grailed.",
    ],
    badge: "10",
    badgeLabel: "NWT",
  },
  {
    file: "public/social/condition-grading.png",
    headline: ["What Is Clothing", "Condition Grading?"],
    subline: [
      "The 1.0–10.0 scale, seven tiers, and the",
      "five weighted factors graders assess.",
    ],
    badge: "8.0",
    badgeLabel: "VERY GOOD",
  },
  {
    file: "public/social/grading-standard.png",
    headline: ["The GradeThread", "Grading Standard"],
    subline: [
      "A published 1.0–10.0 rubric with five",
      "weighted factors and confidence scoring.",
    ],
    badge: "9.0",
    badgeLabel: "NWOT",
  },
  {
    file: "public/social/transparency.png",
    headline: ["Grading Accuracy &", "Transparency Report"],
    subline: [
      "Published AI-vs-human agreement, mean",
      "error, confidence, and dispute rate.",
    ],
    badge: "9.5",
    badgeLabel: "REPORT",
  },
  {
    file: "public/social/faq.png",
    headline: ["GradeThread", "Questions, Answered"],
    subline: [
      "AI grading, the 1.0–10.0 scale, disputes,",
      "certificates, pricing, and the API.",
    ],
    badge: "FAQ",
    badgeLabel: "ANSWERS",
  },
  {
    // US-2581: the Help Center hub and its 14 category shelves share this one
    // card. An article gets a dynamic card naming itself (/og/help/:slug); a
    // shelf has no single subject to put on one, and a per-category static
    // image would be 14 files that go stale the moment a category is renamed.
    file: "public/social/help.png",
    headline: ["Help Center"],
    subline: [
      "Grading, FlipDesk, marketplaces, the",
      "extension, the apps, and what to do",
      "when something goes wrong.",
    ],
    badge: "?",
    badgeLabel: "ANSWERS",
  },
];

const wasm = readFileSync(
  resolve(root, "node_modules/@resvg/resvg-wasm/index_bg.wasm"),
);
await initWasm(wasm);

function render(card) {
  const svg = buildSvg(card);
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  const png = resvg.render().asPng();
  const out = resolve(root, card.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`[og-image] wrote ${card.file} (${png.length} bytes, 1200×630)`);
}

render(DEFAULT_CARD);
for (const card of ROUTE_CARDS) render(card);
console.log(`[og-image] done — ${1 + ROUTE_CARDS.length} images`);
