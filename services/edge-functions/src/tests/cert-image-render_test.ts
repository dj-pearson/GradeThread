// Verifies the Deno-edge certificate image renderer (satori + resvg-wasm)
// produces valid PNGs — the replacement for the CPU-capped Cloudflare workers-og
// path that 503'd. og/badge/slab-label need no network (no hero fetch), so these
// run offline and deterministically.

import { assert, assertEquals } from "@std/assert";
import {
  type CertImageData,
  fetchImageDataUri,
  renderCertImage,
} from "../lib/cert-image-render.ts";

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

Deno.test("renders a valid badge PNG", async () => {
  assert(isPng(await renderCertImage("badge", "square", DATA)));
});

Deno.test("renders a valid label slab PNG (no hero)", async () => {
  assert(isPng(await renderCertImage("slab", "label", DATA)));
});

Deno.test("fetchImageDataUri returns null on empty/invalid input", async () => {
  assertEquals(await fetchImageDataUri(null), null);
  assertEquals(await fetchImageDataUri(""), null);
  // a data: URI is returned unchanged
  assertEquals(await fetchImageDataUri("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
});
