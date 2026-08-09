// One home for "turn a stored grading photo into something the vision API will
// accept" (extracted in US-2443).
//
// This was THREE copies. grading-pipeline.ts had `uint8ToBase64` +
// `mediaTypeForVision`; grading-eval.ts had a byte-for-byte re-implementation of
// both inside `downloadCaseImage`, with a comment reading "mirrors
// grading-pipeline.ts uint8ToBase64" — which is the shape that always drifts,
// because the comment is the only thing holding the two together and a comment
// cannot fail a build. Adding the per-image shadow path would have made it four.
//
// The invariant they all encode is not obvious and is worth keeping in one
// place: the Anthropic vision API sniffs the actual bytes and 400s the whole
// call when the declared media_type disagrees with them, and storage paths lie
// (a `.webp`-named object holding JPEG bytes is a real case that failed whole
// gradings). So the media type comes from the MAGIC BYTES, with the extension as
// a last resort.

import { supabaseAdmin } from "./supabase.ts";
import { IMAGE_CONTENT_TYPE, sniffImageFormat } from "./upload-validation.ts";

/**
 * Base64-encode a byte array in 32KB chunks.
 *
 * The naive `binary += String.fromCharCode(...)` loop is O(n²) on string growth
 * and slow for multi-MB photos; applying fromCharCode over the whole array at
 * once risks a call-stack overflow. Chunking avoids both.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // 32768
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/** Media type from the bytes, falling back to the extension. See the header. */
export function mediaTypeForVision(bytes: Uint8Array, storagePath: string): string {
  const sniffed = sniffImageFormat(bytes);
  // Anthropic accepts jpeg/png/webp/gif and NOT heic. `submission-images` does
  // admit heic (widened by 00323 for iPhone uploads), so this is a real path and
  // not a defensive one: a heic sniff falls through to the extension guess,
  // which declares image/jpeg and lets the API reject it with its own message,
  // rather than us declaring image/heic and being 400'd for the media type.
  // The upload path is where a heic should be transcoded; this function's job is
  // only to stop declaring a type the bytes contradict.
  if (sniffed && sniffed !== "heic") return IMAGE_CONTENT_TYPE[sniffed];
  const ext = storagePath.split(".").pop()?.toLowerCase() || "jpg";
  const extMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return extMap[ext] || "image/jpeg";
}

/**
 * Download one object from the PRIVATE submission-images bucket and return it as
 * a data URI ready for a vision call. Throws on failure — callers decide whether
 * that aborts a grade (the pipeline) or drops one case (eval, shadow).
 */
export async function downloadGradingImage(storagePath: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from("submission-images")
    .download(storagePath);
  if (error || !data) {
    throw new Error(`download failed: ${error?.message ?? "no body"}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  return `data:${mediaTypeForVision(bytes, storagePath)};base64,${uint8ToBase64(bytes)}`;
}
