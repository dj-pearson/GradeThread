// US-3139: the OCR engine wrapper. One lazily created tesseract.js worker,
// shared by every caller, torn down when it has been idle for a while.
//
// Nothing in here decides what a group is CALLED — that is autolister-tag-ocr.ts
// (pure, unit-tested). This file owns only the parts that need a browser: the
// wasm worker, the image fetch, and the downscale.
//
// ── Why every path is absolute and local ──────────────────────────────────
// public/_headers pins the app to `script-src 'self'` and `connect-src 'self'
// …`. tesseract.js's defaults pull the worker from unpkg and the language data
// from tessdata.projectnaptha.com, and BOTH are blocked in production with no
// error the user can see. scripts/copy-tesseract-assets.mjs stages the runtime
// into public/tesseract/ and these paths point at that. Changing them to a CDN
// breaks the feature only in prod, never in dev.

import type { Worker as TesseractWorker } from "tesseract.js";

const ASSET_BASE = "/tesseract/";

// LSTM only. It matches the 4.0.0 traineddata we ship and the `-lstm` cores the
// staging script stages; asking for the legacy engine would request a core file
// that is deliberately not deployed.
const OEM_LSTM_ONLY = 1;

// A garment label is legible well below full resolution, and OCR cost scales
// with pixel count. 1600px on the long edge reads a woven tag comfortably and
// keeps a pass near a second instead of near ten.
const MAX_OCR_EDGE = 1600;

// Tear the worker down after this long with no work. It holds ~30 MB of wasm
// heap, which is worth keeping across a burst of groups and not worth keeping
// for the rest of the session.
const IDLE_TEARDOWN_MS = 60_000;

let workerPromise: Promise<TesseractWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = 0;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng", OEM_LSTM_ONLY, {
        workerPath: `${ASSET_BASE}worker.min.js`,
        // Directories, not files: the worker appends the core variant it picked
        // by feature detection (relaxedsimd / simd / plain) and the language
        // filename itself.
        corePath: ASSET_BASE,
        langPath: ASSET_BASE,
        gzip: true,
      });
    })().catch((err) => {
      // A failed load must not poison every later attempt.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function scheduleTeardown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (inFlight > 0) return;
    void terminateOcrWorker();
  }, IDLE_TEARDOWN_MS);
}

/** Drop the worker and its wasm heap now. Safe to call when none exists. */
export async function terminateOcrWorker(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Already gone, or never finished loading. Nothing to clean up.
  }
}

/**
 * Fetch the image and shrink it if it is larger than the OCR needs. Returns the
 * original blob unchanged when the browser has no OffscreenCanvas or the image
 * is already small — a slower pass beats no pass.
 */
async function loadForOcr(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OCR image fetch failed: ${res.status}`);
  const blob = await res.blob();

  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return blob;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_OCR_EDGE) return blob;
    const scale = MAX_OCR_EDGE / longest;
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: "image/png" });
  } catch {
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Read the text off one image. Returns "" when the engine finds nothing — the
 * caller treats "no text" and "no brand" the same way, so this never throws for
 * an unreadable photo, only for a genuine load/fetch failure.
 */
export async function recognizeImageText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return "";
  inFlight++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    const blob = await loadForOcr(url, signal);
    if (signal?.aborted) return "";
    const worker = await getWorker();
    if (signal?.aborted) return "";
    const { data } = await worker.recognize(blob);
    return data.text ?? "";
  } finally {
    inFlight--;
    if (inFlight === 0) scheduleTeardown();
  }
}
