// US-333: tamper-evident certificate integrity unit tests.
//
// Covers the property the AC cares about most: hashing/signing is stable across
// serialization (string-vs-number scores, key order, unicode) and tampering is
// detected. No network/DB deps — this module is pure Web Crypto + Deno.env.
import { assert, assertEquals } from "@std/assert";
import {
  _resetSigningKeyCacheForTest,
  buildCertIntegrity,
  canonicalizeCertificate,
  CERT_INTEGRITY_VERSION,
  type CertIntegrityFields,
  computeContentHash,
  verifyCertIntegrity,
} from "../lib/cert-integrity.ts";

const BASE: CertIntegrityFields = {
  certificate_id: "11111111-2222-3333-4444-555555555555",
  overall_score: 7.5,
  grade_tier: "Very Good",
  fabric_condition_score: 8.0,
  structural_integrity_score: 7.0,
  cosmetic_appearance_score: 7.5,
  functional_elements_score: 8.0,
  odor_cleanliness_score: 9.0,
  ai_summary: "A well-kept garment with light, even wear throughout.",
};

Deno.test("content hash is deterministic for identical input", async () => {
  const a = await computeContentHash(BASE);
  const b = await computeContentHash({ ...BASE });
  assertEquals(a, b);
  assertEquals(a.length, 64); // SHA-256 hex
});

Deno.test("hash is stable across string-vs-number scores (PostgREST numeric)", async () => {
  // The DB returns numeric as a string; the write path used JS numbers.
  const fromDb: CertIntegrityFields = {
    ...BASE,
    overall_score: "7.5",
    fabric_condition_score: "8.0",
    structural_integrity_score: "7",
    cosmetic_appearance_score: "7.50",
    functional_elements_score: "8",
    odor_cleanliness_score: "9.0",
  };
  assertEquals(
    await computeContentHash(BASE),
    await computeContentHash(fromDb),
  );
});

Deno.test("canonical string ignores key insertion order", () => {
  const reordered: CertIntegrityFields = {
    ai_summary: BASE.ai_summary,
    odor_cleanliness_score: BASE.odor_cleanliness_score,
    overall_score: BASE.overall_score,
    grade_tier: BASE.grade_tier,
    certificate_id: BASE.certificate_id,
    functional_elements_score: BASE.functional_elements_score,
    cosmetic_appearance_score: BASE.cosmetic_appearance_score,
    structural_integrity_score: BASE.structural_integrity_score,
    fabric_condition_score: BASE.fabric_condition_score,
  };
  assertEquals(
    canonicalizeCertificate(BASE),
    canonicalizeCertificate(reordered),
  );
});

Deno.test("changing any score changes the hash", async () => {
  const base = await computeContentHash(BASE);
  const bumped = await computeContentHash({ ...BASE, overall_score: 7.6 });
  assert(base !== bumped, "a 0.1 score change must change the hash");
});

Deno.test("hash-only verify: matches → verified, tamper → mismatch", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY"); // no signing key → hash-only mode
  const { content_hash, content_signature, integrity_version } =
    await buildCertIntegrity(BASE);
  assertEquals(content_signature, null);
  assertEquals(integrity_version, CERT_INTEGRITY_VERSION);

  const ok = await verifyCertIntegrity(
    BASE,
    content_hash,
    null,
    integrity_version,
  );
  assertEquals(ok.status, "verified");
  assertEquals(ok.verified, true);
  assertEquals(ok.signed, false);

  // Tamper a stored field (raise the grade) but keep the old hash.
  const bad = await verifyCertIntegrity(
    { ...BASE, overall_score: 9.5 },
    content_hash,
    null,
    integrity_version,
  );
  assertEquals(bad.status, "mismatch");
  assertEquals(bad.verified, false);
});

Deno.test("signed verify: valid signature → verified", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-signing-secret-aaaaaaaaaaaaaaaa");
  const integ = await buildCertIntegrity(BASE);
  assert(integ.content_signature, "expected a signature when key is set");

  const ok = await verifyCertIntegrity(
    BASE,
    integ.content_hash,
    integ.content_signature,
    integ.integrity_version,
  );
  assertEquals(ok.status, "verified");
  assertEquals(ok.verified, true);
  assertEquals(ok.signed, true);
  assertEquals(ok.algorithm, "SHA-256 + HMAC-SHA256");
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
});

Deno.test("signed verify: tampered fields fail even if attacker recomputes the hash", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-signing-secret-aaaaaaaaaaaaaaaa");
  const integ = await buildCertIntegrity(BASE);

  // Attacker raises the grade AND recomputes the SHA-256 (which is unkeyed),
  // but can't forge the HMAC without the secret. The stored signature no longer
  // validates over the new hash.
  const tampered: CertIntegrityFields = { ...BASE, overall_score: 9.5 };
  const tamperedHash = await computeContentHash(tampered);
  const res = await verifyCertIntegrity(
    tampered,
    tamperedHash, // attacker-updated hash matches the tampered fields...
    integ.content_signature, // ...but the original signature is over the old hash
    integ.integrity_version,
  );
  assertEquals(res.status, "mismatch");
  assertEquals(res.verified, false);
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
});

Deno.test("missing stored hash → unverifiable (legacy grade)", async () => {
  const res = await verifyCertIntegrity(BASE, null, null, null);
  assertEquals(res.status, "unverifiable");
  assertEquals(res.verified, false);
});
