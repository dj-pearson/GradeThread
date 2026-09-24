// Snap-to-Value formatting and input helpers, kept out of the page so they can
// be unit-tested and shared.

// SNAP-08: what Snap sends. The vision model downsamples to about 1568px, 1600
// is still above the certified bridge's 1200px minimum, and JPEG never comes
// back from Safari as a multi-MB PNG.
export const SNAP_COMPRESS = { maxEdge: 1600, quality: 0.82, outputType: "image/jpeg" } as const;
/** The server refuses above 4.5 MB of image; stay well under it. */
export const SNAP_MAX_UPLOAD_BYTES = 4_000_000;
/** Above this a phone is likely to fail decoding the original at all. */
export const SNAP_MAX_SOURCE_BYTES = 40_000_000;

/** Refusals we can name before decoding anything. */
export function snapFileProblem(file: File): string | null {
  const heic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (heic) {
    return "HEIC photos can't be read here. Choose a JPEG, or set your iPhone camera to Most Compatible (Settings, Camera, Formats).";
  }
  return null;
}
