// SUB-10: dispute evidence photos, sized to fit the request.
//
// The dispute POST carries each photo as a base64 data URL, and the edge caps
// a request body at 15 MB (UPLOAD_MAX_BYTES in middleware/body-limit.ts).
// Raw phone photos run 3 to 6 MB each and grow by a third as base64, so three
// or four of them used to 413 and nothing was filed. The server also refuses
// more than 8 (MAX_DISPUTE_EVIDENCE in routes/grade.ts), which the dialog
// never said.

/** Mirrors MAX_DISPUTE_EVIDENCE in services/edge-functions/src/routes/grade.ts. */
export const MAX_DISPUTE_EVIDENCE = 8;

/** The edge body limit, less room for the reason text and JSON framing. */
export const DISPUTE_BODY_BUDGET_BYTES = 14 * 1024 * 1024;

export const EVIDENCE_MAX_WIDTH = 1600;
export const EVIDENCE_QUALITY = 0.85;

/** Bytes a blob of `size` bytes takes as a base64 data URL. */
export function dataUrlBytes(size: number, mime = "image/webp"): number {
  return `data:${mime};base64,`.length + Math.ceil(size / 3) * 4;
}

/**
 * Add picked files to the selection, up to the cap. Returns what was kept
 * and how many were refused, so the dialog can say so.
 */
export function addEvidenceFiles(
  current: readonly File[],
  incoming: readonly File[],
  max = MAX_DISPUTE_EVIDENCE,
): { photos: File[]; refused: number } {
  const room = Math.max(0, max - current.length);
  return {
    photos: [...current, ...incoming.slice(0, room)],
    refused: Math.max(0, incoming.length - room),
  };
}

export interface PreparedEvidence {
  images: string[];
  totalBytes: number;
  overBudget: boolean;
}

/**
 * Shrink each photo, then encode it. `compress` is lib/image-utils
 * compressImage in the app; it is a parameter so the budget can be tested
 * without a canvas. A photo that cannot be decoded is sent as-is and left to
 * the server's own validation, which drops it and reports the count.
 */
export async function prepareEvidence(
  photos: readonly File[],
  compress: (file: File) => Promise<Blob>,
  toDataUrl: (blob: Blob) => Promise<string>,
  budget = DISPUTE_BODY_BUDGET_BYTES,
): Promise<PreparedEvidence> {
  const images: string[] = [];
  let totalBytes = 0;
  for (const photo of photos) {
    let blob: Blob = photo;
    try {
      blob = await compress(photo);
    } catch {
      /* undecodable here; the server decides */
    }
    const url = await toDataUrl(blob);
    totalBytes += url.length;
    images.push(url);
  }
  return { images, totalBytes, overBudget: totalBytes > budget };
}
