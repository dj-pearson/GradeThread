// Generates the 1200×630 social share image (public/og-image.png) used as the
// default og:image / twitter:image for GradeThread links and certificates.
//
// Run on demand to regenerate after a brand/tagline change:
//   node scripts/generate-og-image.mjs
//
// @resvg/resvg-wasm (v2.x) cannot load custom fonts, so we vectorize every text
// run to SVG <path> data with opentype.js first (using the Liberation Sans TTFs
// on the build image). The resulting SVG has no font dependency, so the raster
// is deterministic and needs no headless browser. The brand wordmark is
// embedded as a base64 PNG so the mark is pixel-accurate.

import { readFileSync, writeFileSync } from "node:fs";
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

function loadFont(p) {
  const buf = readFileSync(p);
  return opentype.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}
const bold = loadFont(
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
);
const regular = loadFont(
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
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
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
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
  ${textPath(bold, "9.5", 1040, 272, 92, "#ffffff", "middle")}
  ${textPath(bold, "EXCELLENT", 1040, 322, 22, RED, "middle")}

  <!-- Headline -->
  ${textPath(bold, "The Standard for Clothing", 80, 360, 60, "#ffffff")}
  ${textPath(bold, "Condition Grading", 80, 434, 60, "#ffffff")}
  <rect x="82" y="462" width="150" height="8" rx="4" fill="${RED}"/>

  <!-- Subline -->
  ${textPath(regular, "Objective AI condition grades and verifiable", 80, 520, 30, SLATE)}
  ${textPath(regular, "certificates buyers trust.", 80, 560, 30, SLATE)}

  ${textPath(bold, "gradethread.com", 80, 600, 26, RED)}
</svg>`;

const wasm = readFileSync(
  resolve(root, "node_modules/@resvg/resvg-wasm/index_bg.wasm"),
);
await initWasm(wasm);

const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
const png = resvg.render().asPng();
const out = resolve(root, "public/og-image.png");
writeFileSync(out, png);
console.log(`[og-image] wrote ${out} (${png.length} bytes, 1200×630)`);
