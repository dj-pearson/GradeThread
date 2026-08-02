// Read access to the PRIVATE `submission-images` bucket.
//
// US-2360: this module used to also export uploadSubmissionImage and
// deleteSubmissionImage — a client-direct-to-storage upload path that validated
// on the browser-supplied MIME type alone. That contradicts the US-276 upload
// contract, which requires the server to sniff MAGIC BYTES (a client MIME string
// is attacker-controlled and says nothing about the actual bytes) and to strip
// EXIF/GPS before anything reaches storage.upload().
//
// Neither had a caller, so nothing was exploitable — but they worked, they read
// as correct, and the only thing between them and production was that nobody had
// imported them yet. Deleted rather than documented. If a client-side upload is
// ever genuinely wanted it goes through the validated edge path;
// src/test/no-client-storage-upload.test.ts fails the build if a new direct one
// appears.

import { supabase } from "./supabase";

const BUCKET_NAME = "submission-images";

/**
 * Signed-URL lifetime for the PRIVATE submission-images bucket.
 *
 * CLAUDE.md caps private-bucket signed URLs at 900s, and every other path that
 * reads this bucket already uses 15 minutes (admin-compliance, flipdesk-
 * disclosure, cert images, listing-eval). This one was 3600s, so a link to a
 * seller's garment and LABEL photos — which can carry names, addresses and
 * receipts — stayed live four times longer than policy if it leaked through a
 * referrer, a screenshot, or a log.
 *
 * Practical effect of the reduction: these URLs are minted when the admin
 * dispute dialog opens and dropped when it closes, so only a review session
 * left open past 15 minutes sees broken images — reopening the dialog re-signs
 * them. That is the intended trade against the exposure window.
 *
 * US-2273: exported so the item-photo display resolver reuses the same lifetime
 * for its private-bucket (tag/tag_2/certificate) reads rather than re-deriving a
 * cap the signed-url-ttl guard would then have to re-police in a new file.
 */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export async function getImageUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error) {
    throw new Error(`Failed to create signed URL: ${error.message}`);
  }

  return data.signedUrl;
}
