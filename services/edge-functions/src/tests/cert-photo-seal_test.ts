// US-3516: a certificate sealed at integrity v5 binds the graded photo bytes.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildCertIntegrity,
  CERT_INTEGRITY_VERSION,
  CERT_INTEGRITY_VERSION_WITH_PHOTOS,
  type CertIntegrityFields,
  verifyCertIntegrity,
} from "../lib/cert-integrity.ts";
import {
  type PhotoHashRow,
  type PhotoSealStore,
  sealedPhotoList,
  sha256OfBytes,
  verifyCertificateWithPhotos,
} from "../lib/cert-photo-seal.ts";

const BASE: CertIntegrityFields = {
  certificate_id: "cert-1",
  overall_score: 8.4,
  grade_tier: "Excellent",
  fabric_condition_score: 8.5,
  structural_integrity_score: 8.5,
  cosmetic_appearance_score: 8,
  functional_elements_score: 8.5,
  odor_cleanliness_score: 8.5,
  ai_summary: "Light pilling on the cuffs.",
  buyer_writeup: "",
};

const FRONT = new TextEncoder().encode("front photo bytes");
const BACK = new TextEncoder().encode("back photo bytes");

async function setup() {
  const files = new Map<string, Uint8Array>([
    ["o/s/front_1.jpg", FRONT],
    ["o/s/back_1.jpg", BACK],
  ]);
  const rows: PhotoHashRow[] = [
    {
      image_type: "front",
      storage_path: "o/s/front_1.jpg",
      content_sha256: await sha256OfBytes(FRONT),
    },
    {
      image_type: "back",
      storage_path: "o/s/back_1.jpg",
      content_sha256: await sha256OfBytes(BACK),
    },
  ];
  const store: PhotoSealStore = {
    loadRows: () => Promise.resolve(rows),
    download: (p) => Promise.resolve(files.get(p) ?? null),
  };
  const sealed = await buildCertIntegrity({
    ...BASE,
    photo_hashes: sealedPhotoList(rows),
  });
  return { files, rows, store, sealed };
}

Deno.test("US-3516: no photo_hashes seals v4 exactly as before; supplying them seals v5", async () => {
  const v4 = await buildCertIntegrity(BASE);
  assertEquals(v4.integrity_version, CERT_INTEGRITY_VERSION);
  const v5 = await buildCertIntegrity({ ...BASE, photo_hashes: [] });
  assertEquals(v5.integrity_version, CERT_INTEGRITY_VERSION_WITH_PHOTOS);
  assert(v4.content_hash !== v5.content_hash);
});

Deno.test("US-3516: the sealed list is order-insensitive and skips unhashed rows", () => {
  const a = sealedPhotoList([
    { image_type: "back", content_sha256: "bb" },
    { image_type: "front", content_sha256: "aa" },
    { image_type: "label", content_sha256: null },
  ]);
  assertEquals(a, ["back:bb", "front:aa"]);
});

Deno.test("US-3516: untouched photos verify", async () => {
  const { store, sealed } = await setup();
  const res = await verifyCertificateWithPhotos(
    BASE,
    sealed.content_hash,
    sealed.content_signature,
    sealed.integrity_version,
    "s",
    store,
  );
  assertEquals(res.status, "verified");
  assertEquals(res.photos_checked, 2);
  assertEquals(res.photos_altered, []);
});

Deno.test("US-3516: a file swapped under an unchanged row fails as a mismatch", async () => {
  const { files, store, sealed } = await setup();
  files.set("o/s/front_1.jpg", new TextEncoder().encode("a worse jacket"));
  const res = await verifyCertificateWithPhotos(
    BASE,
    sealed.content_hash,
    sealed.content_signature,
    sealed.integrity_version,
    "s",
    store,
  );
  assertEquals(res.status, "mismatch");
  assertEquals(res.verified, false);
  assertEquals(res.photos_altered, ["front"]);
});

Deno.test("US-3516: a deleted photo fails", async () => {
  const { files, store, sealed } = await setup();
  files.delete("o/s/back_1.jpg");
  const res = await verifyCertificateWithPhotos(
    BASE,
    sealed.content_hash,
    sealed.content_signature,
    sealed.integrity_version,
    "s",
    store,
  );
  assertEquals(res.status, "mismatch");
  assertEquals(res.photos_altered, ["back"]);
});

Deno.test("US-3516: an edited hash list (row and file swapped together) fails the seal", async () => {
  const { files, rows, store, sealed } = await setup();
  const worse = new TextEncoder().encode("a worse jacket");
  files.set("o/s/front_1.jpg", worse);
  rows[0] = { ...rows[0]!, content_sha256: await sha256OfBytes(worse) };
  const res = await verifyCertificateWithPhotos(
    BASE,
    sealed.content_hash,
    sealed.content_signature,
    sealed.integrity_version,
    "s",
    store,
  );
  assertEquals(res.status, "mismatch");
  assertEquals(res.photos_altered, []);
});

Deno.test("US-3516: a v4 certificate verifies without touching photos", async () => {
  const { store } = await setup();
  const v4 = await buildCertIntegrity(BASE);
  let loaded = false;
  const spy: PhotoSealStore = {
    loadRows: (id) => {
      loaded = true;
      return store.loadRows(id);
    },
    download: store.download,
  };
  const res = await verifyCertificateWithPhotos(
    BASE,
    v4.content_hash,
    v4.content_signature,
    v4.integrity_version,
    "s",
    spy,
  );
  assertEquals(res.status, "verified");
  assertEquals(loaded, false);
  // And the plain verifier still answers the same for v4.
  assertEquals(
    (await verifyCertIntegrity(
      BASE,
      v4.content_hash,
      v4.content_signature,
      v4.integrity_version,
    )).status,
    "verified",
  );
});

Deno.test("US-3516: a photo read failure on a v5 row is unverifiable, never verified", async () => {
  const { sealed } = await setup();
  const broken: PhotoSealStore = {
    loadRows: () => Promise.reject(new Error("db down")),
    download: () => Promise.resolve(null),
  };
  const res = await verifyCertificateWithPhotos(
    BASE,
    sealed.content_hash,
    sealed.content_signature,
    sealed.integrity_version,
    "s",
    broken,
  );
  assertEquals(res.status, "unverifiable");
  assertEquals(res.verified, false);
});
