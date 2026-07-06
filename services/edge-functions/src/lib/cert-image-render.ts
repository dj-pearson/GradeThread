// US-763 (edge rewrite): render certificate images (slab / OG card / badge) on
// the Deno edge with satori (HTML→SVG) + @resvg/resvg-wasm (SVG→PNG). This
// replaces the Cloudflare Pages workers-og render, which exceeds the Free-plan
// Worker CPU limit (HTTP 503 "error code: 1102"). The edge has full CPU.
//
// Font (Inter) and the resvg WASM binary are BUNDLED under ../../assets and read
// from disk once (self-contained — no runtime CDN fetch for the engine). The
// satori/satori-html/resvg-wasm JS modules are esm.sh imports baked into the
// image by the Dockerfile's `deno cache` step.

import satori from "satori";
import { html } from "satori-html";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import {
  buildCertBadgeHtml,
  buildCertOgHtml,
  buildCertSlabHtml,
  qrSvgDataUri,
} from "./cert-og-template.ts";

export type SlabFormat = "square" | "portrait" | "story" | "label";

export const SLAB_FORMATS: Record<
  SlabFormat,
  { width: number; height: number; labelOnly?: boolean }
> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  label: { width: 1080, height: 1080, labelOnly: true },
};

// ── One-time engine init (fonts + resvg wasm), cached at module scope ────
let enginePromise: Promise<{ fonts: SatoriFont[] }> | null = null;

interface SatoriFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
}

function engine(): Promise<{ fonts: SatoriFont[] }> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [font400, font700, wasm] = await Promise.all([
        Deno.readFile(new URL("../../assets/fonts/inter-400.woff", import.meta.url)),
        Deno.readFile(new URL("../../assets/fonts/inter-700.woff", import.meta.url)),
        Deno.readFile(new URL("../../assets/wasm/resvg.wasm", import.meta.url)),
      ]);
      await initWasm(wasm); // must run exactly once per process
      const buf = (u: Uint8Array): ArrayBuffer =>
        u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
      return {
        fonts: [
          { name: "Inter", data: buf(font400), weight: 400, style: "normal" },
          { name: "Inter", data: buf(font700), weight: 700, style: "normal" },
        ] as SatoriFont[],
      };
    })().catch((err) => {
      enginePromise = null; // allow a retry on transient init failure
      throw err;
    });
  }
  return enginePromise;
}

/** HTML string → PNG bytes at the given canvas size. */
async function renderPng(markup: string, width: number, height: number): Promise<Uint8Array> {
  const { fonts } = await engine();
  const svg = await satori(html(markup) as never, { width, height, fonts });
  return new Resvg(svg).render().asPng();
}

/**
 * Fetch an image URL and return a `data:` URI, or null on any failure/timeout.
 * Used to embed the hero photo into the slab so satori never does its own
 * (failure-prone) remote fetch. Caps size so a huge source can't OOM the render.
 */
export async function fetchImageDataUri(
  url: string | null | undefined,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  const { timeoutMs = 6000, maxBytes = 6_000_000 } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return `data:${ct};base64,${btoa(bin)}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface CertImageData {
  certId: string;
  title: string;
  brand: string | null;
  score: number;
  gradeTier: string;
  /** A data: URI for the hero photo (pre-fetched via fetchImageDataUri), or null. */
  heroDataUri: string | null;
  /** Absolute cert URL for the slab QR (e.g. https://gradethread.com/cert/:id?s=qr). */
  certUrl: string;
}

/** Render one certificate image kind to PNG bytes. */
export function renderCertImage(
  kind: "slab" | "og" | "badge",
  format: SlabFormat,
  d: CertImageData,
): Promise<Uint8Array> {
  if (kind === "og") {
    return renderPng(
      buildCertOgHtml({ title: d.title, brand: d.brand, score: d.score, gradeTier: d.gradeTier }),
      1200,
      630,
    );
  }
  if (kind === "badge") {
    return renderPng(
      buildCertBadgeHtml({ score: d.score, gradeTier: d.gradeTier, title: d.title }),
      700,
      180,
    );
  }
  // slab
  const fmt = SLAB_FORMATS[format] ?? SLAB_FORMATS.square;
  const markup = buildCertSlabHtml({
    width: fmt.width,
    height: fmt.height,
    title: d.title,
    brand: d.brand,
    score: d.score,
    gradeTier: d.gradeTier,
    heroImageUrl: fmt.labelOnly ? null : d.heroDataUri,
    qrDataUri: qrSvgDataUri(d.certUrl),
    certId: d.certId,
  });
  return renderPng(markup, fmt.width, fmt.height);
}
