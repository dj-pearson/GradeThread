import { assertEquals } from "@std/assert";

// flipdesk-ebay.ts (and its ebay-client import) read the service-role supabase
// client + env at load, so set dummy env BEFORE the dynamic import (same pattern
// as offer-already-ended_test / publish-idempotency_test).
//   deno test --allow-env src/tests/ebay-grade-promotion_test.ts
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { applyGradeListingPromotion, allowedAspectsFromSpec, stripCertLinks } =
  await import("../routes/flipdesk-ebay.ts");
const { resolveMeasurementAspects } = await import("../lib/measurements.ts");

// US-1502: the grade item specific value is "GradeThread <n.n>" under the
// "Condition Grade" key. certificate_url:null keeps the test DB-free (the cert
// branch that lazily backfills a number is skipped).
const GRADE_KEY = "Condition Grade";

Deno.test("promotion: injects the Condition Grade specific when absent", async () => {
  const aspects: Record<string, string[]> = {};
  const desc = await applyGradeListingPromotion(
    { grade_value: 9, certificate_url: null },
    aspects,
    "A nice jacket.",
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 9.0"]);
  assertEquals(desc, "A nice jacket."); // no cert url → description unchanged
});

Deno.test("promotion: non-force PRESERVES an existing grade specific", async () => {
  const aspects: Record<string, string[]> = { [GRADE_KEY]: ["GradeThread 5.0"] };
  await applyGradeListingPromotion(
    { grade_value: 9, certificate_url: null },
    aspects,
    "desc",
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 5.0"]);
});

Deno.test("promotion: force OVERWRITES a stale/overstated grade specific (downgrade)", async () => {
  const aspects: Record<string, string[]> = { [GRADE_KEY]: ["GradeThread 9.0"] };
  await applyGradeListingPromotion(
    { grade_value: 6.5, certificate_url: null },
    aspects,
    "desc",
    { force: true },
  );
  assertEquals(aspects[GRADE_KEY], ["GradeThread 6.5"]);
});

Deno.test("promotion: no grade value is a no-op on the aspect map", async () => {
  const aspects: Record<string, string[]> = {};
  const desc = await applyGradeListingPromotion(
    { grade_value: null, certificate_url: null },
    aspects,
    "keep me",
  );
  assertEquals(aspects[GRADE_KEY], undefined);
  assertEquals(desc, "keep me");
});

// ── Off-eBay link strip: legacy US-1126 credential blocks ──────────
// Older AutoLister generations embedded the verified-seller credential block
// WITH an <a href> to gradethread.com/verified/<handle>; eBay hides listings
// whose description links off-eBay, so publish/revise must scrub stored
// descriptions (new generations are link-free at the source).

const LEGACY_CREDENTIAL_DESC =
  `<p>Nice polo.</p>\n` +
  `<!--gradethread-seller-credentials--><div style="border:1px solid #e5e7eb">` +
  `<div style="font-weight:700">✓ GradeThread Verified Seller — Pearson Mercantile</div>` +
  `<div>13 items independently graded · <strong>8.2 / 10</strong> average condition grade</div>` +
  `<a href="https://gradethread.com/verified/pearson" style="color:#0F3460">See every verified grade ↗</a>` +
  `</div>`;

Deno.test("strip: removes the legacy credential anchor, keeps name + stats", () => {
  const out = stripCertLinks(LEGACY_CREDENTIAL_DESC);
  assertEquals(out.includes("https://"), false);
  assertEquals(out.includes("<a"), false);
  assertEquals(out.includes("See every verified grade"), false);
  // The trust text survives — only the link goes.
  assertEquals(out.includes("Verified Seller — Pearson Mercantile"), true);
  assertEquals(out.includes("8.2 / 10"), true);
  assertEquals(out.includes("Nice polo."), true);
});

Deno.test("strip: removes the plain-text verified-profile URL line", () => {
  const out = stripCertLinks(
    "Great shirt.\n\nGradeThread Verified Seller\nPearson\n" +
      "See every verified grade: https://gradethread.com/verified/pearson\n",
  );
  assertEquals(out.includes("https://"), false);
  assertEquals(out.includes("Great shirt."), true);
  assertEquals(out.includes("Verified Seller"), true);
});

Deno.test("strip: removes bare /verified/ and /cert/ URLs", () => {
  const out = stripCertLinks(
    "See https://gradethread.com/verified/px and https://gradethread.com/cert/abc here.",
  );
  assertEquals(/https?:\/\//.test(out), false);
});

Deno.test("promotion: strips legacy credential link even when UNGRADED (revise path)", async () => {
  const out = await applyGradeListingPromotion(
    { grade_value: null, certificate_url: null },
    {},
    LEGACY_CREDENTIAL_DESC,
    { force: true },
  );
  assertEquals(out.includes("https://"), false);
  assertEquals(out.includes("Verified Seller — Pearson Mercantile"), true);
});

// ── US-1503: measurement aspects flow through the derive/revise paths ──
// allowedAspectsFromSpec converts eBay's raw category spec into the
// name->allowedValues map resolveMeasurementAspects consumes; together they map
// stored measurements onto the category's FREE-TEXT measurement aspects (never a
// SELECTION_ONLY style dropdown, never clobbering a set value).

const rawSpec = (
  name: string,
  values: string[] = [],
) => ({
  localizedAspectName: name,
  aspectValues: values.map((localizedValue) => ({ localizedValue })),
});

Deno.test("allowedAspectsFromSpec: raw spec → name→allowedValues map", () => {
  const map = allowedAspectsFromSpec([
    rawSpec("Sleeve Length"), // free-text (no values)
    rawSpec("Style", ["Bomber", "Parka"]), // dropdown
  ]);
  assertEquals(map, { "Sleeve Length": [], Style: ["Bomber", "Parka"] });
});

Deno.test("US-1503: measurements map onto free-text category aspects only", () => {
  const allowed = allowedAspectsFromSpec([
    rawSpec("Sleeve Length"), // free-text → gets the value
    rawSpec("Chest Size"), // free-text → gets the value
    rawSpec("Inseam", ["30", "32", "34"]), // SELECTION_ONLY → skipped
  ]);
  const out = resolveMeasurementAspects(
    { sleeve: 25, chest: 21, inseam: 32 },
    allowed,
    {},
  );
  assertEquals(out["Sleeve Length"], ["25 in"]);
  assertEquals(out["Chest Size"], ["21 in"]);
  assertEquals(out["Inseam"], undefined); // dropdown not force-filled
});

Deno.test("US-1503: measurement fold never clobbers an already-set aspect", () => {
  const allowed = allowedAspectsFromSpec([rawSpec("Chest Size")]);
  const out = resolveMeasurementAspects(
    { chest: 21 },
    allowed,
    { "Chest Size": ["Seller value"] }, // existing wins
  );
  assertEquals(out["Chest Size"], undefined);
});
