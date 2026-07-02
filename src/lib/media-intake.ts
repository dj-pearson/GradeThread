// Graceful intake of non-standard upload inputs (US-1300).
//
// Two iPhone-shaped problems land on our web upload surfaces and, until now,
// were silently rejected:
//
//   1. Live Photos exported from a Mac/desktop arrive as a QuickTime/MP4 VIDEO
//      (`.mov` / `.mp4`) rather than a still. We grab a single frame and turn it
//      into a JPEG so the user's photo "just works".
//   2. HEIC/HEIF stills that Chrome/Firefox can't decode natively.
//
// Both conversions run FULLY in the browser and are CSP-safe under our
// enforcing policy:
//   - Video frame grab uses a <video> + <canvas> (needs `media-src 'self' blob:`
//     — added in public/_headers).
//   - HEIC decode uses `heic-to/csp`, the WebAssembly-only build that avoids
//     `new Function`/eval, so it runs under the `wasm-unsafe-eval` we already
//     allow (the default `heic-to`/old `heic2any` builds need `unsafe-eval`,
//     which our CSP blocks — that is why HEIC upload was failing in production).
//
// The native iOS app never reaches this code: its PHPicker uses `.images`, which
// already hands back the still for a Live Photo and excludes pure videos.

// A typed failure so each upload surface can message the user precisely and
// distinguish a video-frame failure from a HEIC-decode failure for its stats.
export class MediaIntakeError extends Error {
  readonly kind: "video" | "heic";
  constructor(kind: "video" | "heic", message: string) {
    super(message);
    this.name = "MediaIntakeError";
    this.kind = kind;
  }
}

const VIDEO_EXT = /\.(mov|mp4|m4v|qt|hevc|webm|avi|mkv|3gp)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

// Live Photos / phone clips. We key off the browser-declared MIME first (most
// reliable when present) and fall back to the extension for the common case
// where a dragged `.mov` arrives with an empty `type`.
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  if (file.type) return false; // a non-empty, non-video type is authoritative
  return VIDEO_EXT.test(file.name);
}

export function isHeicFile(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    (file.type === "" && HEIC_EXT.test(file.name))
  );
}

// A grossly oversized "video" is almost never a Live Photo (those are a few MB /
// a couple seconds). Refuse before we hand a multi-GB file to a <video> decoder.
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function waitForMediaEvent(
  el: HTMLVideoElement,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new MediaIntakeError("video", "The video couldn't be opened."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new MediaIntakeError("video", "The video took too long to load."));
    }, timeoutMs);
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

/**
 * Decode a single still frame from a video file and return it as a JPEG `File`.
 * Used to recover a usable photo from an iPhone Live Photo that exported as
 * `.mov`/`.mp4`. Best-effort: throws a {@link MediaIntakeError} (kind "video")
 * with a user-facing message on any decode failure.
 */
export async function extractVideoFrame(
  file: File,
  opts: { seekSeconds?: number; quality?: number } = {},
): Promise<File> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new MediaIntakeError(
      "video",
      "That video is too large to convert. Save a photo from it and upload that instead.",
    );
  }
  const quality = opts.quality ?? 0.92;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    await waitForMediaEvent(video, "loadedmetadata", 20_000);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // Seek a hair into the clip — the very first frame of a Live Photo is often
    // black/blurred as the camera settles. Stay safely before the end.
    const target = opts.seekSeconds ??
      (duration > 0.2 ? Math.min(0.1, duration / 2) : 0);

    const seeked = waitForMediaEvent(video, "seeked", 20_000);
    video.currentTime = target;
    await seeked;

    // Where supported, make sure a frame is actually presented before we draw.
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      // Best-effort: in a throttled/backgrounded tab the frame callback may
      // never fire — proceed after a short wait rather than hanging the upload
      // lane forever (the seeked frame is almost always drawable already).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        rvfc.call(video, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      throw new MediaIntakeError("video", "This video had no readable frame.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new MediaIntakeError("video", "Couldn't render the video frame.");
    }
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob || blob.size === 0) {
      throw new MediaIntakeError("video", "Couldn't encode the video frame.");
    }

    return new File([blob], replaceExt(file.name, "jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch (err) {
    if (err instanceof MediaIntakeError) throw err;
    throw new MediaIntakeError(
      "video",
      "Couldn't read this video. Save a photo from it and upload that instead.",
    );
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Transcode an iPhone HEIC/HEIF still to JPEG in the browser. Uses the CSP-safe
 * `heic-to/csp` build (WASM only), dynamic-imported so the ~3MB decoder never
 * enters the main bundle. Throws a {@link MediaIntakeError} (kind "heic") on
 * failure.
 */
export async function transcodeHeic(
  file: File,
  quality = 0.9,
): Promise<File> {
  try {
    const { heicTo } = await import("heic-to/csp");
    const blob = await heicTo({ blob: file, type: "image/jpeg", quality });
    return new File([blob], replaceExt(file.name, "jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    throw new MediaIntakeError(
      "heic",
      "HEIC conversion failed. Re-export as JPEG (Photos → Share → Save as Files) and add it again.",
    );
  }
}

/**
 * Normalize any picked file into an image `File` the upload pipeline accepts:
 * a Live Photo / video becomes a still JPEG frame, HEIC/HEIF becomes JPEG, and
 * everything else passes through untouched. Throws {@link MediaIntakeError} so
 * callers can route the message + per-kind stats.
 */
export async function normalizeToImageFile(file: File): Promise<File> {
  if (isVideoFile(file)) return extractVideoFrame(file);
  if (isHeicFile(file)) return transcodeHeic(file);
  return file;
}

function replaceExt(name: string, ext: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || "photo"}.${ext}`;
}
