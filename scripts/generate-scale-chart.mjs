// Generates the free printable one-page condition-grade chart (US-1664 AC2):
//   public/gradethread-condition-grading-scale.png
//
// The chart carries the GradeThread name and lays out the full 1.0–10.0 scale —
// every grade band with its label, criteria, and marketplace equivalent — as a
// portrait PNG resellers can download and print. Deterministic (no headless
// browser): text runs are vectorized to SVG <path> data with opentype.js, then
// rasterized with @resvg/resvg-wasm — the SAME approach as generate-og-image.mjs.
//
// The band copy mirrors src/lib/seo/grading-scale.ts (the on-page table is the
// canonical source for humans/crawlers; this PNG is a print convenience). Commit
// the generated PNG like the OG images. Regenerate after a scale/brand change:
//   node scripts/generate-scale-chart.mjs

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
const INK = "#1f2937";
const MUTED = "#4b5563";
const HAIR = "#e5e7eb";
const STRIPE = "#f7f8fa";
const SLATE = "#94a3b8";

function firstExisting(paths, label) {
  const found = paths.find((p) => existsSync(p));
  if (!found) throw new Error(`[scale-chart] no ${label} font found. Tried:\n  ${paths.join("\n  ")}`);
  return found;
}
function loadFont(p) {
  const buf = readFileSync(p);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
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

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function textPath(font, text, x, baseline, size, fill, anchor = "start") {
  let drawX = x;
  if (anchor === "middle") drawX = x - font.getAdvanceWidth(text, size) / 2;
  const d = font.getPath(text, drawX, baseline, size).toPathData(2);
  return `<path d="${d}" fill="${fill}"/>`;
}
// Greedy word-wrap using the font's advance-width metrics.
function wrap(font, text, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (font.getAdvanceWidth(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Band copy — mirrors src/lib/seo/grading-scale.ts (kept concise for print).
const BANDS = [
  { score: "10", label: "NWT — New With Tags", criteria: "Brand-new, unworn, with original retail tags attached.", market: "eBay “New with tags”" },
  { score: "9", label: "NWOT — New Without Tags", criteria: "New and unworn; the original tags have been removed.", market: "eBay “New without tags”" },
  { score: "8", label: "Excellent", criteria: "Gently used with no notable flaws; looks nearly new.", market: "Excellent Used (EUC)" },
  { score: "7", label: "Very Good", criteria: "Light, even wear that doesn’t affect look or function.", market: "Very Good Used (VGUC)" },
  { score: "6", label: "Good", criteria: "Visible but minor wear; still very wearable.", market: "Good Used (GUC)" },
  { score: "5", label: "Fair", criteria: "A documented flaw that affects appearance — disclose it.", market: "Pre-owned, flaws disclosed" },
  { score: "3–4", label: "Poor", criteria: "Significant damage or heavy wear; sold transparently as-is.", market: "“For parts” / distressed" },
];

const W = 1080;
const MARGIN = 56;
const COL_GRADE = 84;
const COL_LABEL = 168;
const COL_CRIT = 470;
const COL_MARKET = 820;
const CRIT_W = COL_MARKET - COL_CRIT - 24;
const MARKET_W = W - MARGIN - COL_MARKET;

// Header block height, then measure each row so nothing clips.
const HEADER_H = 300;
const ROW_PAD = 28;
const LINE = 30;

const rowLayouts = BANDS.map((b) => {
  const critLines = wrap(regular, b.criteria, 21, CRIT_W);
  const marketLines = wrap(regular, b.market, 21, MARKET_W);
  const lines = Math.max(critLines.length, marketLines.length, 1);
  return { ...b, critLines, marketLines, h: lines * LINE + ROW_PAD * 2 };
});
const tableTop = HEADER_H;
const TABLE_HEAD_H = 52;
let y = tableTop + TABLE_HEAD_H;
const rows = rowLayouts.map((r) => {
  const top = y;
  y += r.h;
  return { ...r, top };
});
const FOOTER_H = 92;
const H = y + FOOTER_H;

const logoB64 = readFileSync(resolve(root, "public/logo_primary.png")).toString("base64");

const rowSvg = rows
  .map((r, i) => {
    const stripe = i % 2 === 1 ? `<rect x="${MARGIN}" y="${r.top}" width="${W - MARGIN * 2}" height="${r.h}" fill="${STRIPE}"/>` : "";
    const base = r.top + ROW_PAD + 22;
    const crit = r.critLines.map((l, j) => textPath(regular, esc(l), COL_CRIT, base + j * LINE, 21, MUTED)).join("");
    const market = r.marketLines.map((l, j) => textPath(regular, esc(l), COL_MARKET, base + j * LINE, 21, MUTED)).join("");
    return `${stripe}
    ${textPath(bold, r.score, COL_GRADE, base + 2, 30, NAVY, "middle")}
    ${textPath(bold, esc(r.label), COL_LABEL, base, 21, INK)}
    ${crit}
    ${market}
    <line x1="${MARGIN}" y1="${r.top + r.h}" x2="${W - MARGIN}" y2="${r.top + r.h}" stroke="${HAIR}" stroke-width="1"/>`;
  })
  .join("\n");

const defLines = wrap(
  regular,
  "A standardized 1.0–10.0 system for the condition of pre-owned clothing — scored across five weighted factors and mapped to seven named tiers.",
  23,
  W - MARGIN * 2,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="12" height="${H}" fill="${RED}"/>
  <image x="${MARGIN}" y="52" width="300" height="62" href="data:image/png;base64,${logoB64}"/>
  ${textPath(bold, "The Clothing Condition Grading Scale", MARGIN, 176, 42, NAVY)}
  ${defLines.map((l, i) => textPath(regular, esc(l), MARGIN, 220 + i * 32, 23, MUTED)).join("\n  ")}

  <!-- Table header -->
  <rect x="${MARGIN}" y="${tableTop}" width="${W - MARGIN * 2}" height="${TABLE_HEAD_H}" fill="${NAVY}"/>
  ${textPath(bold, "Grade", COL_GRADE, tableTop + 34, 19, "#ffffff", "middle")}
  ${textPath(bold, "Tier", COL_LABEL, tableTop + 34, 19, "#ffffff")}
  ${textPath(bold, "Criteria", COL_CRIT, tableTop + 34, 19, "#ffffff")}
  ${textPath(bold, "Marketplace", COL_MARKET, tableTop + 34, 19, "#ffffff")}

  ${rowSvg}

  <!-- Footer -->
  <rect x="0" y="${H - FOOTER_H}" width="${W}" height="${FOOTER_H}" fill="${NIGHT}"/>
  ${textPath(bold, "gradethread.com/grading/scale", MARGIN, H - FOOTER_H + 42, 24, "#ffffff")}
  ${textPath(regular, "The GradeThread Scale — the standard for pre-owned clothing condition.", MARGIN, H - FOOTER_H + 72, 18, SLATE)}
</svg>`;

const wasm = readFileSync(resolve(root, "node_modules/@resvg/resvg-wasm/index_bg.wasm"));
await initWasm(wasm);
const resvg = new Resvg(svg, { fitTo: { mode: "width", value: W } });
const png = resvg.render().asPng();
const out = resolve(root, "public/gradethread-condition-grading-scale.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[scale-chart] wrote public/gradethread-condition-grading-scale.png (${png.length} bytes, ${W}×${H})`);
