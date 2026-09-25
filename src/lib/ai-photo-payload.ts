import { compressImage } from "@/lib/image-utils";
import type { FlipdeskPhotoType } from "@/types/database";

export interface InlineAiPhoto {
  /** base64, no data: prefix */
  data: string;
  media_type: "image/jpeg";
  type: FlipdeskPhotoType;
  role?: string;
}

const AI_EDGE_PX = 1024;
const AI_MAX_PHOTOS = 8;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("Could not read the photo."));
    r.readAsDataURL(blob);
  });
}

/** Tag shots first: the tag is where brand, size and fiber are read from. */
export function orderForAi<T extends { photoType: FlipdeskPhotoType }>(photos: readonly T[]): T[] {
  return [...photos].sort((a, b) => Number(b.photoType === "tag") - Number(a.photoType === "tag"));
}

/**
 * Staged intake photos as the extract route takes them inline: downscaled to
 * about 1024px on the long edge and re-encoded as JPEG (which also drops
 * EXIF/GPS), tag first, at most eight. A photo that cannot be decoded here is
 * skipped rather than failing the whole AI Fill.
 */
export async function stagedPhotosForAi(
  photos: readonly { file: File; photoType: FlipdeskPhotoType; photoRole?: string | null }[],
): Promise<InlineAiPhoto[]> {
  const out: InlineAiPhoto[] = [];
  for (const p of orderForAi(photos).slice(0, AI_MAX_PHOTOS)) {
    try {
      const small = await compressImage(p.file, {
        maxEdge: AI_EDGE_PX,
        quality: 0.8,
        outputType: "image/jpeg",
      });
      out.push({
        data: await blobToBase64(small.blob),
        media_type: "image/jpeg",
        type: p.photoType,
        ...(p.photoRole ? { role: p.photoRole } : {}),
      });
    } catch {
      /* skip a photo this browser cannot decode */
    }
  }
  return out;
}
