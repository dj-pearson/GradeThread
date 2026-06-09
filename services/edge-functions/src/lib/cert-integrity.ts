// Tamper-evident certificate integrity (US-333).
//
// At grade finalization we compute a canonical content hash of the certificate's
// already-public fields and (optionally) an HMAC signature over that hash. The
// public verify endpoint re-derives the hash from the stored fields and confirms
// it matches — so an altered DB row, or a forged certificate screenshot, can be
// detected: the QR resolves to the canonical /cert/:id whose integrity is then
// checked server-side against this hash + signature.
//
// DESIGN NOTES
// - We hash ONLY the certified GRADE fields (scores, tier, AI summary,
//   certificate id), never the seller-editable submission title/brand or the
//   DB-generated created_at. The hash certifies the grade, not the listing copy,
//   and stays reproducible from the public certificate payload alone.
// - Postgres `numeric` can come back from PostgREST as a string; both the write
//   path (JS numbers) and the verify path (DB values) go through the SAME
//   canonicalizer, which coerces every score to a fixed 1-decimal string, so the
//   hash is stable across serialization round-trips.
// - Signing is OPTIONAL: with CERT_SIGNING_KEY set, only the server can mint a
//   valid signature, so a tamperer can't recompute a matching one. Without it we
//   still detect any field/hash mismatch (hash-only integrity).

// Bump when the canonical field set or normalization changes. Stored per-row so
// a future scheme can verify old rows under their original rules.
// v1 (US-333): scores + tier + ai_summary + certificate_id.
// v2 (US-770): additionally seals buyer_writeup (the buyer-facing certified
//   condition report, US-759). Old v1 rows still verify under version 1.
export const CERT_INTEGRITY_VERSION = 2;

const SIGNING_KEY_ENV = "CERT_SIGNING_KEY";

export interface CertIntegrityFields {
  certificate_id: string;
  overall_score: number | string;
  grade_tier: string;
  fabric_condition_score: number | string;
  structural_integrity_score: number | string;
  cosmetic_appearance_score: number | string;
  functional_elements_score: number | string;
  odor_cleanliness_score: number | string;
  ai_summary: string;
  // US-759/US-770: the longer buyer-facing write-up. Sealed from v2 onward;
  // absent/ignored when canonicalizing under version 1.
  buyer_writeup?: string | null;
}

export interface CertIntegrity {
  content_hash: string;
  content_signature: string | null;
  integrity_version: number;
}

export interface CertVerifyResult {
  // 'verified'      — hash (and signature, if signed) matches the stored fields
  // 'mismatch'      — the stored fields don't hash to the stored value: tampered
  // 'unverifiable'  — no integrity hash on record (legacy grade) or bad input
  status: "verified" | "mismatch" | "unverifiable";
  verified: boolean;
  signed: boolean;
  algorithm: string;
  integrity_version: number | null;
  // The hash recomputed from the stored fields (hex). Equals the stored hash
  // when status === 'verified'. Exposed for transparency; it is not secret.
  content_hash: string | null;
}

// Coerce a score to a deterministic fixed-1-decimal string (e.g. 7 -> "7.0",
// "8.50" -> "8.5"). Throws on non-finite input so a bad row can't silently hash.
function score1(v: number | string): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`cert-integrity: non-numeric score ${JSON.stringify(v)}`);
  }
  return n.toFixed(1);
}

// Deterministic, serialization-stable canonical string for the certificate.
// Keys are emitted in a fixed sorted order; scores are normalized; text is
// Unicode-normalized (NFC) so visually-identical text hashes alike.
//
// `version` selects the canonical field set so old rows verify under their
// ORIGINAL rules: v1 omits buyer_writeup entirely (and emits `v:1`), producing
// byte-identical output to the original scheme; v2+ also seals buyer_writeup.
export function canonicalizeCertificate(
  f: CertIntegrityFields,
  version: number = CERT_INTEGRITY_VERSION,
): string {
  const obj: Record<string, unknown> = {
    ai_summary: (f.ai_summary ?? "").normalize("NFC"),
    certificate_id: String(f.certificate_id),
    cosmetic_appearance_score: score1(f.cosmetic_appearance_score),
    fabric_condition_score: score1(f.fabric_condition_score),
    functional_elements_score: score1(f.functional_elements_score),
    grade_tier: String(f.grade_tier),
    odor_cleanliness_score: score1(f.odor_cleanliness_score),
    overall_score: score1(f.overall_score),
    structural_integrity_score: score1(f.structural_integrity_score),
    v: version,
  };
  // US-770: v2+ seals the buyer-facing certified write-up. v1 rows never carry
  // this key, so they keep hashing exactly as they did before the bump.
  if (version >= 2) {
    obj.buyer_writeup = (f.buyer_writeup ?? "").normalize("NFC");
  }
  // Pass the sorted key list as the replacer so output order is fixed
  // regardless of insertion order.
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

// Stable SHA-256 of the canonical certificate. `version` controls the field
// set (see canonicalizeCertificate) — defaults to the current scheme for the
// write path; the verify path passes the row's stored integrity_version.
export function computeContentHash(
  f: CertIntegrityFields,
  version: number = CERT_INTEGRITY_VERSION,
): Promise<string> {
  return sha256Hex(canonicalizeCertificate(f, version));
}

let signingKey: CryptoKey | null | undefined;

// Import the HMAC key from CERT_SIGNING_KEY (raw UTF-8 secret). Cached. Returns
// null when unset — signing is optional and the system degrades to hash-only.
async function loadSigningKey(): Promise<CryptoKey | null> {
  if (signingKey !== undefined) return signingKey;
  const raw = Deno.env.get(SIGNING_KEY_ENV)?.trim();
  if (!raw) {
    signingKey = null;
    return null;
  }
  signingKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return signingKey;
}

// Test seam: reset the cached key after mutating CERT_SIGNING_KEY in a test.
export function _resetSigningKeyCacheForTest(): void {
  signingKey = undefined;
}

// HMAC-SHA256(hashHex) as base64, or null when no signing key is configured.
export async function signContentHash(hashHex: string): Promise<string | null> {
  const key = await loadSigningKey();
  if (!key) return null;
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(hashHex),
  );
  return base64Encode(new Uint8Array(sig));
}

// Constant-time HMAC verify (Web Crypto's verify is constant-time). False when
// no key is configured or the signature is malformed.
export async function verifyContentSignature(
  hashHex: string,
  signatureB64: string | null | undefined,
): Promise<boolean> {
  if (!signatureB64) return false;
  const key = await loadSigningKey();
  if (!key) return false;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = base64Decode(signatureB64);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(hashHex),
  );
}

// Compute the integrity payload to persist at grade finalization.
export async function buildCertIntegrity(
  f: CertIntegrityFields,
): Promise<CertIntegrity> {
  const content_hash = await computeContentHash(f);
  const content_signature = await signContentHash(content_hash);
  return {
    content_hash,
    content_signature,
    integrity_version: CERT_INTEGRITY_VERSION,
  };
}

// Verify stored integrity against the stored fields. `storedHash` / `storedSig`
// come from the grade_reports row; `f` is rebuilt from the same row's fields.
export async function verifyCertIntegrity(
  f: CertIntegrityFields,
  storedHash: string | null | undefined,
  storedSig: string | null | undefined,
  integrityVersion: number | null | undefined,
): Promise<CertVerifyResult> {
  const algorithm = storedSig ? "SHA-256 + HMAC-SHA256" : "SHA-256";
  if (!storedHash) {
    return {
      status: "unverifiable",
      verified: false,
      signed: false,
      algorithm,
      integrity_version: integrityVersion ?? null,
      content_hash: null,
    };
  }

  // Verify under the row's ORIGINAL scheme. A stored hash with no version is a
  // pre-versioning (v1) row, so default to 1 — never to the current constant,
  // which would break every legacy certificate after a version bump.
  const verifyVersion = integrityVersion ?? 1;

  let recomputed: string;
  try {
    recomputed = await computeContentHash(f, verifyVersion);
  } catch {
    return {
      status: "unverifiable",
      verified: false,
      signed: Boolean(storedSig),
      algorithm,
      integrity_version: integrityVersion ?? null,
      content_hash: null,
    };
  }

  const hashMatches = recomputed === storedHash;
  // When a signature is on record we require BOTH the field hash to match AND
  // the signature to validate over the recomputed hash — that's what makes a
  // recompute-by-attacker insufficient. Without a signature, hash-match alone.
  let verified = hashMatches;
  let signed = false;
  if (storedSig) {
    signed = true;
    const sigValid = await verifyContentSignature(recomputed, storedSig);
    verified = hashMatches && sigValid;
  }

  return {
    status: verified ? "verified" : "mismatch",
    verified,
    signed,
    algorithm,
    integrity_version: integrityVersion ?? null,
    content_hash: recomputed,
  };
}
