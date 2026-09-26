// US-3516: bind a certificate to the exact photo bytes that were graded.
//
// cert-integrity.ts sealed the grade CLAIMS (scores, tier, text, coverage,
// verdict) and said in its own copy that it "does not cryptographically bind
// the photographs themselves". So a certificate could keep verifying while the
// files behind its gallery changed. 00837 stops clients writing into a graded
// submission folder; this makes any change that still happens (service role,
// dashboard, storage restore) visible to a buyer.
//
// Two halves:
//   1. At upload, every submission_images row records content_sha256 of the
//      bytes actually stored (after EXIF stripping). Integrity v5 seals the
//      sorted list of `${image_type}:${sha256}`, so the list itself cannot be
//      edited without the certificate failing.
//   2. The public verify re-hashes the stored files and compares them with the
//      recorded hashes, so a file swapped under an unchanged row fails too.
//
// Rows with no hash (graded before 00839) are simply not part of the seal.

import { supabaseAdmin } from "./supabase.ts";
import {
  CERT_INTEGRITY_VERSION_WITH_PHOTOS,
  type CertIntegrityFields,
  type CertVerifyResult,
  verifyCertIntegrity,
} from "./cert-integrity.ts";

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface PhotoHashRow {
  image_type: string;
  storage_path?: string | null;
  content_sha256: string | null;
}

/** The sealed form: `${image_type}:${sha256}`, hashed rows only, sorted. */
export function sealedPhotoList(rows: readonly PhotoHashRow[]): string[] {
  return rows
    .filter((r) =>
      typeof r.content_sha256 === "string" && r.content_sha256 !== ""
    )
    .map((r) => `${r.image_type}:${r.content_sha256}`)
    .sort();
}

export interface PhotoSealStore {
  loadRows: (submissionId: string) => Promise<PhotoHashRow[]>;
  download: (storagePath: string) => Promise<Uint8Array | null>;
}

export const defaultPhotoSealStore: PhotoSealStore = {
  loadRows: async (submissionId) => {
    const { data, error } = await supabaseAdmin
      .from("submission_images")
      .select("image_type, storage_path, content_sha256")
      .eq("submission_id", submissionId);
    if (error) throw new Error(`photo hash read failed: ${error.message}`);
    return (data ?? []) as PhotoHashRow[];
  },
  download: async (storagePath) => {
    const { data, error } = await supabaseAdmin.storage
      .from("submission-images")
      .download(storagePath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  },
};

/** The v5 photo list for a submission. Throws on a read error. */
export async function loadSealedPhotoHashes(
  submissionId: string,
  store: PhotoSealStore = defaultPhotoSealStore,
): Promise<string[]> {
  return sealedPhotoList(await store.loadRows(submissionId));
}

export interface StoredPhotoCheck {
  /** Hashed rows whose file was downloaded and re-hashed. */
  checked: number;
  /** image_types whose stored bytes no longer match, or whose file is gone. */
  altered: string[];
}

/**
 * Re-hash each stored file that has a recorded hash. A missing file counts as
 * altered: a certificate whose sealed photo was deleted is not intact. Bounded
 * by `limit` so a pathological submission cannot make the public endpoint
 * download without end.
 */
export async function checkStoredPhotoBytes(
  rows: readonly PhotoHashRow[],
  store: PhotoSealStore = defaultPhotoSealStore,
  limit = 24,
): Promise<StoredPhotoCheck> {
  const hashed = rows
    .filter((r) => r.content_sha256 && r.storage_path)
    .slice(0, limit);
  const results = await Promise.all(hashed.map(async (r) => {
    const bytes = await store.download(r.storage_path!);
    if (!bytes) return r.image_type;
    return (await sha256OfBytes(bytes)) === r.content_sha256
      ? null
      : r.image_type;
  }));
  return {
    checked: hashed.length,
    altered: results.filter((t): t is string => t !== null),
  };
}

/**
 * The v5 photo list for the submission behind a grade report, for the reseal
 * paths (human review, disputes, authenticity appeals). Answers undefined on
 * any failure, which makes buildCertIntegrity seal v4: a reseal must never
 * fail a human's correction, and a v4 seal still verifies.
 */
export async function loadPhotoHashesForReport(
  gradeReportId: string,
): Promise<string[] | undefined> {
  try {
    const { data, error } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id")
      .eq("id", gradeReportId)
      .maybeSingle();
    const submissionId = (data as { submission_id?: string } | null)
      ?.submission_id;
    if (error || !submissionId) return undefined;
    return await loadSealedPhotoHashes(submissionId);
  } catch {
    return undefined;
  }
}

/**
 * Verify a certificate, photos included. For a v5 row the sealed photo list is
 * loaded from submission_images (so an edited list fails the hash), and the
 * stored files are re-hashed (so a swapped file under an unchanged row fails
 * too). Older rows verify exactly as before. A photo failure reports
 * `mismatch`, the same verdict as an edited score: to a buyer both mean the
 * certificate no longer describes what was graded.
 */
export async function verifyCertificateWithPhotos(
  fields: CertIntegrityFields,
  storedHash: string | null | undefined,
  storedSig: string | null | undefined,
  integrityVersion: number | null | undefined,
  submissionId: string,
  store: PhotoSealStore = defaultPhotoSealStore,
): Promise<
  CertVerifyResult & { photos_checked: number; photos_altered: string[] }
> {
  if ((integrityVersion ?? 1) < CERT_INTEGRITY_VERSION_WITH_PHOTOS) {
    const res = await verifyCertIntegrity(
      fields,
      storedHash,
      storedSig,
      integrityVersion,
    );
    return { ...res, photos_checked: 0, photos_altered: [] };
  }
  let rows: PhotoHashRow[];
  try {
    rows = await store.loadRows(submissionId);
  } catch {
    const res = await verifyCertIntegrity(
      fields,
      storedHash,
      storedSig,
      integrityVersion,
    );
    return {
      ...res,
      status: "unverifiable",
      verified: false,
      photos_checked: 0,
      photos_altered: [],
    };
  }
  const res = await verifyCertIntegrity(
    { ...fields, photo_hashes: sealedPhotoList(rows) },
    storedHash,
    storedSig,
    integrityVersion,
  );
  const bytes = await checkStoredPhotoBytes(rows, store);
  if (bytes.altered.length > 0 && res.status !== "unverifiable") {
    return {
      ...res,
      status: "mismatch",
      verified: false,
      photos_checked: bytes.checked,
      photos_altered: bytes.altered,
    };
  }
  return {
    ...res,
    photos_checked: bytes.checked,
    photos_altered: bytes.altered,
  };
}
