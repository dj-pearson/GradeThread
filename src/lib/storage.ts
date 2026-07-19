import { supabase } from "./supabase";
import type { ImageType } from "@/types/database";

const BUCKET_NAME = "submission-images";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const MIME_TO_EXT: Record<AllowedMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface UploadResult {
  storagePath: string;
  publicUrl: string;
}

function validateFile(file: File): void {
  if (!ALLOWED_MIME_TYPES.includes(file.type as AllowedMimeType)) {
    throw new Error(
      `Invalid file type "${file.type}". Allowed types: JPEG, PNG, WebP.`
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `File size ${sizeMB}MB exceeds the maximum allowed size of 10MB.`
    );
  }
}

export async function uploadSubmissionImage(
  userId: string,
  submissionId: string,
  file: File,
  imageType: ImageType
): Promise<UploadResult> {
  validateFile(file);

  const ext = MIME_TO_EXT[file.type as AllowedMimeType];
  const timestamp = Date.now();
  const storagePath = `${userId}/${submissionId}/${imageType}_${timestamp}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to upload image: ${error.message}`);
  }

  const publicUrl = await getImageUrl(storagePath);

  return { storagePath, publicUrl };
}

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
 */
const SIGNED_URL_TTL_SECONDS = 15 * 60;

export async function getImageUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error) {
    throw new Error(`Failed to create signed URL: ${error.message}`);
  }

  return data.signedUrl;
}

export async function deleteSubmissionImage(storagePath: string): Promise<void> {
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([storagePath]);

  if (error) {
    throw new Error(`Failed to delete image: ${error.message}`);
  }
}
