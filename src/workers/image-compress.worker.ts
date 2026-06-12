// US-539: off-main-thread image compression for bulk photo staging.
//
// Decodes with createImageBitmap (EXIF orientation applied via "from-image"),
// renders the resized full image + thumbnail on an OffscreenCanvas, and
// computes the 64-bit dHash — all inside a worker so a 100-photo batch never
// blocks the main thread. Spawned and load-balanced by
// src/lib/image-worker-pool.ts, which also provides the main-thread fallback
// for environments without Worker/OffscreenCanvas support.

export interface WorkerCompressRequest {
  id: number;
  file: Blob;
  maxWidth: number;
  quality: number;
  /** null skips thumbnail generation. */
  thumbWidth: number | null;
  thumbQuality: number;
}

export type WorkerCompressResponse =
  | {
      id: number;
      ok: true;
      blob: Blob;
      width: number;
      height: number;
      phash: string;
      thumbBlob: Blob | null;
      /** Dimensions of the ORIGINAL (pre-resize) image, for quality gating. */
      srcWidth: number;
      srcHeight: number;
    }
  | { id: number; ok: false; error: string; decodeFailed: boolean };

// The project tsconfig uses the DOM lib (mixing in the webworker lib clashes
// with it), so type the worker scope minimally instead.
interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerCompressRequest>) => void) | null;
  postMessage(message: WorkerCompressResponse): void;
}
const scope = self as unknown as WorkerScope;

function render(bitmap: ImageBitmap, maxWidth: number): OffscreenCanvas {
  let width = bitmap.width;
  let height = bitmap.height;
  if (width > maxWidth) {
    height = Math.round(height * (maxWidth / width));
    width = maxWidth;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create canvas context.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

// Same dHash as image-utils' computeDHash, on an OffscreenCanvas: 9x8
// grayscale, one bit per horizontal neighbor comparison, 16 hex chars.
// Returns "" on any failure so it can never break an upload.
function computeDHash(bitmap: ImageBitmap): string {
  try {
    const W = 9;
    const H = 8;
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext("2d");
    if (!cx) return "";
    cx.drawImage(bitmap, 0, 0, W, H);
    const { data } = cx.getImageData(0, 0, W, H);

    let bits = "";
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        const j = (y * W + x + 1) * 4;
        const left =
          0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
        const right =
          0.299 * (data[j] ?? 0) + 0.587 * (data[j + 1] ?? 0) + 0.114 * (data[j + 2] ?? 0);
        bits += left > right ? "1" : "0";
      }
    }
    return BigInt("0b" + bits).toString(16).padStart(16, "0");
  } catch {
    return "";
  }
}

async function handle(req: WorkerCompressRequest): Promise<void> {
  let bitmap: ImageBitmap;
  try {
    try {
      // "from-image" applies the EXIF orientation during decode, replacing the
      // manual transform matrix the main-thread compressImage path needs.
      bitmap = await createImageBitmap(req.file, { imageOrientation: "from-image" });
    } catch {
      // Some engines reject the options bag — those apply EXIF orientation by
      // default, so a plain decode is still correctly oriented. A corrupt file
      // fails this call too and lands in the outer catch.
      bitmap = await createImageBitmap(req.file);
    }
  } catch (err) {
    scope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      decodeFailed: true,
    });
    return;
  }

  try {
    const outputType = req.file.type === "image/png" ? "image/png" : "image/webp";
    const full = render(bitmap, req.maxWidth);
    const blob = await full.convertToBlob({ type: outputType, quality: req.quality });
    const phash = computeDHash(bitmap);
    let thumbBlob: Blob | null = null;
    if (req.thumbWidth != null) {
      thumbBlob = await render(bitmap, req.thumbWidth).convertToBlob({
        type: outputType,
        quality: req.thumbQuality,
      });
    }
    scope.postMessage({
      id: req.id,
      ok: true,
      blob,
      width: full.width,
      height: full.height,
      phash,
      thumbBlob,
      srcWidth: bitmap.width,
      srcHeight: bitmap.height,
    });
  } catch (err) {
    scope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      decodeFailed: false,
    });
  } finally {
    bitmap.close();
  }
}

scope.onmessage = (e) => {
  void handle(e.data);
};
