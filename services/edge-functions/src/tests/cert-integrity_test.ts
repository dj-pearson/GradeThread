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

// ── US-2141: v4 seals the coarse authenticity verdict ───────────────────────

Deno.test("v4 seals the authenticity verdict: tampering it is detected", async () => {
  const fields: CertIntegrityFields = {
    ...BASE,
    authenticity_verdict: "likely_authentic",
    authenticity_verdict_confidence: 0.82,
  };
  const hash = await computeContentHash(fields, 4);

  // Downgrading a verdict to "authentic-looking" after the fact is exactly the
  // edit the seal exists to catch.
  const tampered: CertIntegrityFields = { ...fields, authenticity_verdict: "red_flags" };
  const res = await verifyCertIntegrity(tampered, hash, null, 4);
  assertEquals(res.verified, false);
});

Deno.test("v4 seals the verdict CONFIDENCE too", async () => {
  const fields: CertIntegrityFields = {
    ...BASE,
    authenticity_verdict: "likely_authentic",
    authenticity_verdict_confidence: 0.7,
  };
  const hash = await computeContentHash(fields, 4);
  const res = await verifyCertIntegrity(
    { ...fields, authenticity_verdict_confidence: 0.95 },
    hash,
    null,
    4,
  );
  assertEquals(res.verified, false);
});

Deno.test("v4: a grade with no authenticity add-on seals a DEFINED empty verdict", async () => {
  // The common case — the add-on is premium-gated. Both spellings of "absent"
  // must hash identically, or a round-trip through the verify endpoint (which
  // passes `?? null`) would fail against a seal written from `undefined`.
  const omitted = await computeContentHash(BASE, 4);
  const explicitNull = await computeContentHash(
    { ...BASE, authenticity_verdict: null, authenticity_verdict_confidence: null },
    4,
  );
  assertEquals(omitted, explicitNull);

  const res = await verifyCertIntegrity(BASE, omitted, null, 4);
  assertEquals(res.status, "verified");
});

Deno.test("legacy v3 row still verifies after the version bump to v4", async () => {
  // The whole point of storing the version per row: v1-v3 certificates
  // canonicalize without the authenticity keys and must not be invalidated by
  // a bump they predate.
  const v3Fields: CertIntegrityFields = { ...BASE, coverage_pct: 80, covered_zones: ["front"] };
  const v3Hash = await computeContentHash(v3Fields, 3);

  // Even with an authenticity verdict now present on the row, verifying under
  // the STORED version 3 must ignore it.
  const res = await verifyCertIntegrity(
    { ...v3Fields, authenticity_verdict: "red_flags", authenticity_verdict_confidence: 0.5 },
    v3Hash,
    null,
    3,
  );
  assertEquals(res.status, "verified");
});

Deno.test("CERT_INTEGRITY_VERSION is 4 and new seals use it", async () => {
  assertEquals(CERT_INTEGRITY_VERSION, 4);
  const { integrity_version } = await buildCertIntegrity(BASE);
  assertEquals(integrity_version, 4);
});

// ── US-2132: an unsigned certificate must not verify while signing is on ────

Deno.test("signed mode: stripping the signature does NOT yield verified", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-signing-secret-aaaaaaaaaaaaaaaa");

  // The attack this closes: someone with DB write nulls the signature column,
  // edits the scores, and recomputes the (unkeyed) SHA-256 so the hash matches
  // the new fields. That used to return verified:true, signed:false.
  const tampered: CertIntegrityFields = { ...BASE, overall_score: 9.5 };
  const tamperedHash = await computeContentHash(tampered);
  const res = await verifyCertIntegrity(tampered, tamperedHash, null, CERT_INTEGRITY_VERSION);

  assertEquals(res.verified, false);
  assertEquals(res.signed, false);
  // 'unsigned', not 'mismatch' — the fields hash consistently; it is the absent
  // signature that makes them untrustworthy.
  assertEquals(res.status, "unsigned");

  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
});

Deno.test("signed mode: an untampered but unsigned cert is also unsigned, not verified", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-signing-secret-aaaaaaaaaaaaaaaa");

  // A genuine hash-only row sealed before signing was enabled. We cannot tell it
  // apart from the stripped-signature attack above, so it must fail closed too —
  // the distinct status is what keeps it from being reported as tampering.
  const hash = await computeContentHash(BASE);
  const res = await verifyCertIntegrity(BASE, hash, null, CERT_INTEGRITY_VERSION);

  assertEquals(res.verified, false);
  assertEquals(res.status, "unsigned");

  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
});

Deno.test("hash-only mode: with no signing key configured, hash match still verifies", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");

  // Deliberate: signing is optional (see the module header). With no key there
  // is no stronger answer available, so hash-match remains the best we can say.
  const hash = await computeContentHash(BASE);
  const res = await verifyCertIntegrity(BASE, hash, null, CERT_INTEGRITY_VERSION);

  assertEquals(res.status, "verified");
  assertEquals(res.verified, true);
  assertEquals(res.signed, false);

  _resetSigningKeyCacheForTest();
});

// ── US-770: version-aware canonicalization + buyer_writeup sealing ──────────

Deno.test("v1 canonicalization is byte-stable and ignores buyer_writeup", () => {
  // The original (v1) scheme never carried buyer_writeup, so adding one must not
  // change the v1 canonical string — that's what keeps legacy certs verifying.
  const withWriteup: CertIntegrityFields = {
    ...BASE,
    buyer_writeup: "A longer buyer-facing condition report.",
  };
  assertEquals(
    canonicalizeCertificate(BASE, 1),
    canonicalizeCertificate(withWriteup, 1),
  );
  // And the v1 string must NOT mention buyer_writeup or v:2.
  const v1 = canonicalizeCertificate(BASE, 1);
  assert(!v1.includes("buyer_writeup"));
  assert(v1.includes('"v":1'));
});

Deno.test("legacy v1 row still verifies after the version bump to v2", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // Simulate a row sealed under v1 (hash computed with the v1 field set).
  const v1Hash = await computeContentHash(BASE, 1);
  const res = await verifyCertIntegrity(BASE, v1Hash, null, 1);
  assertEquals(res.status, "verified");
  assertEquals(res.verified, true);
});

Deno.test("v2 seals buyer_writeup: tampering it is detected", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  const fields: CertIntegrityFields = {
    ...BASE,
    buyer_writeup: "Authentic 1990s wool overcoat; minor cuff wear; grade reflects light age.",
  };
  const { content_hash, integrity_version } = await buildCertIntegrity(fields);
  assertEquals(integrity_version, CERT_INTEGRITY_VERSION); // 2

  // Same write-up → verified.
  const ok = await verifyCertIntegrity(fields, content_hash, null, integrity_version);
  assertEquals(ok.status, "verified");

  // Altered write-up, same stored hash → mismatch.
  const bad = await verifyCertIntegrity(
    { ...fields, buyer_writeup: "Pristine designer coat, no flaws." },
    content_hash,
    null,
    integrity_version,
  );
  assertEquals(bad.status, "mismatch");
  assertEquals(bad.verified, false);
});

Deno.test("a v2 row with no write-up still verifies (buyer_writeup defaults to empty)", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // BASE has no buyer_writeup; it's sealed as "".
  const { content_hash, integrity_version } = await buildCertIntegrity(BASE);
  const ok = await verifyCertIntegrity(BASE, content_hash, null, integrity_version);
  assertEquals(ok.status, "verified");
});

// US-1279: v3 additionally seals the documented coverage scope (coverage_pct +
// the covered-zone set), so the guarantee scope is tamper-evident and provable.
Deno.test("v3 seals the covered-zone scope: tampering it is detected", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  const fields: CertIntegrityFields = {
    ...BASE,
    coverage_pct: 80,
    covered_zones: ["front", "back", "collar_neckline", "cuffs"],
  };
  const { content_hash, integrity_version } = await buildCertIntegrity(fields);
  assertEquals(integrity_version, CERT_INTEGRITY_VERSION); // 3

  // Same scope → verified.
  const ok = await verifyCertIntegrity(fields, content_hash, null, integrity_version);
  assertEquals(ok.status, "verified");

  // Widening the sealed covered set (claiming a zone was documented when it
  // wasn't) against the same stored hash → mismatch. This is the exact attack
  // the coverage-gated guarantee must resist.
  const widened = await verifyCertIntegrity(
    { ...fields, covered_zones: [...fields.covered_zones!, "lining", "hem"] },
    content_hash,
    null,
    integrity_version,
  );
  assertEquals(widened.status, "mismatch");
  assertEquals(widened.verified, false);
});

Deno.test("v3 seals coverage_pct: tampering it is detected", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  const fields: CertIntegrityFields = { ...BASE, coverage_pct: 60, covered_zones: ["front"] };
  const { content_hash, integrity_version } = await buildCertIntegrity(fields);
  const bad = await verifyCertIntegrity(
    { ...fields, coverage_pct: 100 },
    content_hash,
    null,
    integrity_version,
  );
  assertEquals(bad.status, "mismatch");
});

Deno.test("v3 covered_zones is order-insensitive (canonicalized sorted)", () => {
  // The covered set is a SET; the hash must not depend on the order the zones
  // happen to be listed in the stored jsonb.
  const a = canonicalizeCertificate(
    { ...BASE, coverage_pct: 75, covered_zones: ["front", "back", "cuffs"] },
    3,
  );
  const b = canonicalizeCertificate(
    { ...BASE, coverage_pct: 75, covered_zones: ["cuffs", "front", "back"] },
    3,
  );
  assertEquals(a, b);
});

Deno.test("a v3 row with no coverage still verifies (empty scope)", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // A grade with no coverage record (pre-00308) seals an empty scope under v3
  // and round-trips, exactly as the verify endpoint passes back null coverage.
  const fields: CertIntegrityFields = { ...BASE, coverage_pct: null, covered_zones: null };
  const { content_hash, integrity_version } = await buildCertIntegrity(fields);
  // Tracks the CURRENT version rather than a literal: buildCertIntegrity always
  // seals at CERT_INTEGRITY_VERSION, and what this test is actually about — an
  // absent coverage record round-tripping as a defined empty scope — holds at
  // every version. The v2→v3 and v3→v4 legacy tests cover the pinned cases.
  assertEquals(integrity_version, CERT_INTEGRITY_VERSION);
  const ok = await verifyCertIntegrity(fields, content_hash, null, integrity_version);
  assertEquals(ok.status, "verified");
});

Deno.test("legacy v2 row still verifies after the version bump to v3", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // Seal explicitly under v2 (a row finalized before the v3 bump), then verify
  // it carrying its stored integrity_version=2 — coverage must be ignored.
  const v2Fields: CertIntegrityFields = { ...BASE, buyer_writeup: "Sealed under v2." };
  const hashV2 = await computeContentHash(v2Fields, 2);
  const ok = await verifyCertIntegrity(
    { ...v2Fields, coverage_pct: 42, covered_zones: ["front"] }, // ignored at v2
    hashV2,
    null,
    2,
  );
  assertEquals(ok.status, "verified");
});
