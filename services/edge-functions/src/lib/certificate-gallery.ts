// US-1413: pure helpers for assembling the PUBLIC certificate photo gallery.
//
// The public cert endpoint (content-public.ts GET /certificates/:id) serves the
// garment photos to ANONYMOUS buyers — the certificate's primary audience — via
// service-role signed URLs. The SPA cert route used to read submission_images +
// storage with the anon client, which RLS locks to the owner, so logged-out
// viewers got no photos at all. Keeping the assembly logic pure here lets us
// regression-test the contract (ordering, null-url filtering, hero pick) without
// a live DB or storage.

export interface SubmissionImageRow {
  id: string;
  storage_path: string;
  image_type: string;
  display_order: number;
}

export interface CertGalleryImage {
  id: string;
  image_type: string;
  display_order: number;
  url: string;
}

/** Async signer: a storage path → a signed URL (or null if signing failed). */
export type StoragePathSigner = (storagePath: string) => Promise<string | null>;

/**
 * Sign every image and return the gallery (ascending display_order), dropping
 * any image whose signed URL could not be produced. Input rows are assumed to
 * already be ordered by the query, but we sort defensively.
 */
export async function buildCertGallery(
  rows: SubmissionImageRow[],
  sign: StoragePathSigner,
): Promise<CertGalleryImage[]> {
  const signed = await Promise.all(
    rows.map(async (img) => {
      const url = await sign(img.storage_path);
      return url === null
        ? null
        : {
            id: img.id,
            image_type: img.image_type,
            display_order: img.display_order,
            url,
          };
    }),
  );
  return signed
    .filter((g): g is CertGalleryImage => g !== null)
    .sort((a, b) => a.display_order - b.display_order);
}

/**
 * The representative hero image URL: the `front` photo, else the lowest
 * display_order. Returns null when the gallery is empty. Mirrors the SSR/OG
 * hero selection so both paths show the same image.
 */
export function selectHeroUrl(
  rows: SubmissionImageRow[],
  gallery: CertGalleryImage[],
): string | null {
  const hero = rows.find((i) => i.image_type === "front") ?? rows[0];
  if (!hero) return null;
  return gallery.find((g) => g.id === hero.id)?.url ?? null;
}
