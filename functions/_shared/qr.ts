// US-762: server-side QR generation for edge / Satori rendering.
//
// Cloudflare Pages Functions have no DOM, so the SPA's qrcode.react can't run
// here. We need a QR code burned into server-rendered images (the digital slab,
// US-763) that links a buyer back to the official certificate — the digital
// equivalent of the scannable code on a PSA label.
//
// `qrcode-generator` (Kazuhiko Arase, MIT, zero-dependency, pure JS) does the
// hard part correctly — Reed-Solomon ECC, masking, format/version info — and we
// turn its module matrix into a single-path SVG that Satori (via workers-og)
// renders as an <img src="data:image/svg+xml;base64,…">. Keeping it to one
// <path> (plus a quiet-zone background rect) keeps the SVG tiny and crisp.

import qrcode from "qrcode-generator";

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

// Obsidian navy on white — matches the SPA cert page QR (certificate.tsx) and
// gives a high contrast ratio so the code stays scannable when downscaled to a
// marketplace thumbnail.
const DEFAULT_DARK = "#0C1E36";
const DEFAULT_LIGHT = "#ffffff";

// The QR spec mandates a quiet zone of at least 4 modules around the symbol;
// without it many scanners refuse to lock on. Default to the spec minimum.
const DEFAULT_MARGIN = 4;

export interface QrOptions {
  /** Error-correction level. Default "M" (≈15% recovery) — resilient to the
   *  mild compression/scaling a listing thumbnail goes through. */
  ecl?: QrErrorCorrection;
  /** Quiet-zone width in modules. Default 4 (spec minimum). */
  margin?: number;
  /** Foreground (module) colour. */
  dark?: string;
  /** Background / quiet-zone colour. */
  light?: string;
}

export interface QrMatrix {
  /** Module count per side (excludes the quiet zone). */
  size: number;
  /** Row-major grid; `modules[row][col] === true` means a dark module. */
  modules: boolean[][];
}

/**
 * Encode `text` into a QR module matrix. Byte mode is used because certificate
 * URLs are ASCII/UTF-8; type number 0 auto-selects the smallest version that
 * fits the payload at the chosen error-correction level.
 */
export function qrMatrix(
  text: string,
  opts: { ecl?: QrErrorCorrection } = {},
): QrMatrix {
  if (!text) throw new Error("qrMatrix: text is required");
  const qr = qrcode(0, opts.ecl ?? "M");
  // Byte mode — cert URLs are ASCII, for which the default (SJIS) byte mapping
  // is identical to UTF-8/Latin-1.
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { size, modules };
}

/**
 * Render `text` as a compact, scalable QR SVG (one <path> for all dark modules
 * over a light quiet-zone rect). `shape-rendering="crispEdges"` keeps module
 * boundaries sharp when the image is scaled up in Satori.
 */
export function qrSvg(text: string, opts: QrOptions = {}): string {
  const margin = Math.max(0, Math.floor(opts.margin ?? DEFAULT_MARGIN));
  const dark = opts.dark ?? DEFAULT_DARK;
  const light = opts.light ?? DEFAULT_LIGHT;
  const { size, modules } = qrMatrix(text, { ecl: opts.ecl });
  const dim = size + margin * 2;

  let d = "";
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    if (!row) continue;
    for (let c = 0; c < size; c++) {
      // One unit square per dark module, offset by the quiet zone.
      if (row[c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  // Both viewBox and width/height: Satori reads the intrinsic size from the
  // attributes while the consuming img element's style scales it to the target pixels.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`
  );
}

/**
 * QR as a base64 `data:image/svg+xml` URI, ready to drop into a Satori
 * `<img src=…>`. Base64 (not URL-encoded UTF-8) avoids any ambiguity around the
 * `#` in the colour values. The SVG is pure ASCII, so `btoa` is safe.
 */
export function qrSvgDataUri(text: string, opts: QrOptions = {}): string {
  return `data:image/svg+xml;base64,${btoa(qrSvg(text, opts))}`;
}
