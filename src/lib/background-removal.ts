// US-535: on-device background removal + studio-white compositing.
//
// Runs a free WASM segmentation model (@imgly/background-removal) entirely in
// the browser — no per-image API cost, replacing the paid remove.bg path for
// AutoLister. The model + WASM are fetched once from staticimgly.com (allowed
// in connect-src; script-src carries 'wasm-unsafe-eval'), then cached by the
// browser. The library is dynamically imported so its ~MB of code never enters
// the main bundle — it loads only when a seller actually taps the feature.
//
// removeImageBackground() returns the cutout composited per `mode`, downscaled
// to a sane max edge, plus a matching thumbnail — ready to drop straight into
// the AutoLister staging pipeline.

export type BgMode = "white" | "transparent";

export interface ProcessedImage {
  /** Main image: JPEG for white-backdrop, PNG (alpha preserved) for transparent. */
  full: Blob;
  /** 320px thumbnail in the same format. */
  thumb: Blob;
  width: number;
  height: number;
  contentType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
}

/** Progress callback: 0..1 overall (model download dominates the first call). */
export type BgProgress = (fraction: number) => void;

const MAX_EDGE = 2400;
const THUMB_EDGE = 320;

/**
 * Remove the background from `input` and composite it per `mode`. `onProgress`
 * reports model-download/inference progress (mostly the one-time model fetch).
 */
export async function removeImageBackground(
  input: Blob,
  mode: BgMode,
  onProgress?: BgProgress,
): Promise<ProcessedImage> {
  // Lazy: pulls the segmenter + WASM only on first real use.
  const { removeBackground } = await import("@imgly/background-removal");

  const cutout = await removeBackground(input, {
    output: { format: "image/png" }, // transparent foreground; we composite next
    progress: onProgress
      ? (_key: string, current: number, total: number) => {
          if (total > 0) onProgress(Math.min(1, current / total));
        }
      : undefined,
  });

  const bitmap = await createImageBitmap(cutout);
  try {
    const isWhite = mode === "white";
    const contentType: "image/jpeg" | "image/png" = isWhite
      ? "image/jpeg"
      : "image/png";
    const ext: "jpg" | "png" = isWhite ? "jpg" : "png";

    const main = render(bitmap, MAX_EDGE, isWhite);
    const full = await toBlob(main.canvas, contentType, 0.92);
    const t = render(bitmap, THUMB_EDGE, isWhite);
    const thumb = await toBlob(t.canvas, contentType, 0.8);

    return { full, thumb, width: main.w, height: main.h, contentType, ext };
  } finally {
    bitmap.close();
  }
}

/** Draw `bitmap` scaled to fit `maxEdge`, optionally over a white backdrop. */
function render(
  bitmap: ImageBitmap,
  maxEdge: number,
  white: boolean,
): { canvas: HTMLCanvasElement; w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  if (white) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h };
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality,
    ),
  );
}
