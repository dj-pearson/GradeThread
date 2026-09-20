// US-1715: admin brand-knowledge route — buildPatch write-safety boundary.
// The route imports supabase at load (service-role), so set dummy env before the
// dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildPatch } = await import("../routes/admin-brand-knowledge.ts");

function ok(r: unknown): Record<string, unknown> {
  assert(r && typeof r === "object" && "patch" in (r as object), "expected a patch");
  return (r as { patch: Record<string, unknown> }).patch;
}
function err(r: unknown): string {
  assert(r && typeof r === "object" && "error" in (r as object), "expected an error");
  return (r as { error: string }).error;
}

Deno.test("keeps only editable columns and drops the rest", () => {
  const patch = ok(buildPatch("brand_styles", {
    style_name: "ABC Pant",
    visual_fingerprint: "gusseted crotch",
    brand_key: "hacker", // NOT editable — must be dropped
    id: "x", // not editable
  }));
  assertEquals(patch.style_name, "ABC Pant");
  assertEquals(patch.visual_fingerprint, "gusseted crotch");
  assert(!("brand_key" in patch), "brand_key must never be writable");
  assert(!("id" in patch));
});

Deno.test("rejects an all-non-editable patch as empty", () => {
  assertEquals(
    err(buildPatch("brand_styles", { brand_key: "x", bogus: 1 })),
    "No editable fields in the request",
  );
});

Deno.test("validates confidence is a number in [0,1]", () => {
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 0.8 })).confidence, 0.8);
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 0 })).confidence, 0);
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 1 })).confidence, 1);
  assert(err(buildPatch("brand_knowledge", { confidence: 1.5 })).includes("confidence"));
  assert(err(buildPatch("brand_knowledge", { confidence: -1 })).includes("confidence"));
  assert(err(buildPatch("brand_knowledge", { confidence: "high" })).includes("confidence"));
});

Deno.test("US-1996 AC5: a NULL confidence is no longer writable", () => {
  // ⚠ THIS ASSERTION USED TO SAY THE OPPOSITE — `confidence: null` was passed
  // straight through, and that is how US-1716 AC4's claim that provenance is
  // "schema-enforced" became a convention rather than a rule. 00389 declares
  // both columns NULLABLE and nothing upstream said no. Migration 00578 now
  // enforces it in the database, so accepting a null here would only turn a
  // clean 400 into a constraint violation surfacing as a 500.
  assert(
    err(buildPatch("brand_knowledge", { confidence: null })).includes("required"),
    "a null confidence is rejected with a reason",
  );
  // 0 is still perfectly legal. The requirement is that somebody SAID how sure
  // they were, not that they were sure — 00576 seeds dating claims at 0.4.
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 0 })).confidence, 0);
});

Deno.test("US-1996 AC5: a blank source_url is rejected where the error can explain", () => {
  // The DB constraint refuses a blank, so refusing it here keeps the message
  // useful. `seed:<file>.ts` is deliberately accepted — it names a real origin.
  for (const blank of ["", "   ", null, 42]) {
    assert(
      err(buildPatch("brand_knowledge", { source_url: blank })).includes("source_url"),
      `${JSON.stringify(blank)} is not a source`,
    );
  }
  assertEquals(
    ok(buildPatch("brand_knowledge", { source_url: "  https://example.com/x  " })).source_url,
    "https://example.com/x",
    "and a real one is trimmed rather than stored with whitespace",
  );
  assertEquals(
    ok(buildPatch("brand_knowledge", { source_url: "seed:sizing-charts.ts" })).source_url,
    "seed:sizing-charts.ts",
  );
});

Deno.test("verified must be a boolean", () => {
  assertEquals(ok(buildPatch("brand_colorways", { verified: true })).verified, true);
  assertEquals(ok(buildPatch("brand_colorways", { verified: false })).verified, false);
  assert(err(buildPatch("brand_colorways", { verified: "yes" })).includes("verified"));
});

Deno.test("each table exposes its own editable columns only", () => {
  // brand_size_charts owns `rows`; brand_styles does not.
  assert("rows" in ok(buildPatch("brand_size_charts", { rows: [] })));
  assertEquals(
    err(buildPatch("brand_styles", { rows: [] })),
    "No editable fields in the request",
  );
  // brand_style_codes owns `pattern`.
  assert("pattern" in ok(buildPatch("brand_style_codes", { pattern: "^x$" })));
});

// ── US-1768: structured authentication_tells enforcement on write ────────────
Deno.test("authentication_tells: a valid structured array is canonicalized", () => {
  const patch = ok(buildPatch("brand_knowledge", {
    authentication_tells: [
      { category: "date_code", claim: "Stamped, not printed", check: "look under tab", confidence: 0.7 },
      { category: "weird", claim: "legacy", confidence: 9 }, // canonicalized on write
    ],
  }));
  const tells = patch.authentication_tells as Array<Record<string, unknown>>;
  assertEquals(tells.length, 2);
  assertEquals(tells[1].category, "other", "unknown category → other");
  assertEquals(tells[1].confidence, 1, "confidence clamps to [0,1]");
});

Deno.test("authentication_tells: a non-array is rejected (can't wipe the column)", () => {
  assert(err(buildPatch("brand_knowledge", { authentication_tells: { claim: "x" } })).length > 0);
});

Deno.test("authentication_tells: an entry with no claim is rejected", () => {
  assert(err(buildPatch("brand_knowledge", { authentication_tells: [{ check: "no claim" }] })).length > 0);
});

Deno.test("authentication_tells validation only applies to brand_knowledge", () => {
  // On another table 'authentication_tells' isn't an editable column, so it's
  // silently dropped rather than validated — and an all-non-editable patch errors.
  assert(err(buildPatch("brand_styles", { authentication_tells: "whatever" })).length > 0);
});

// US-3406: size_class became editable, and the column has no CHECK constraint.
Deno.test("US-3406: size_class and size_system are writable but validated", () => {
  const ok = buildPatch("brand_size_charts", { size_class: "plus" });
  assertEquals("patch" in ok ? ok.patch : null, { size_class: "plus" });

  // The reason the validation exists: with no constraint on the column, an
  // arbitrary string is stored and isSpecialisedChart then reads it as
  // non-standard and demotes an ordinary chart out of the lead.
  const bad = buildPatch("brand_size_charts", { size_class: "extra-roomy" });
  assert("error" in bad, "an unknown size_class must be refused");
  assert(/size_class must be null or one of/.test((bad as { error: string }).error));

  // null is a real value here: roughly 260 rows carry it, and it is what lets
  // the derivation from the garment scope run.
  const cleared = buildPatch("brand_size_charts", { size_class: null });
  assertEquals("patch" in cleared ? cleared.patch : null, { size_class: null });

  const sys = buildPatch("brand_size_charts", { size_system: "UK" });
  assertEquals("patch" in sys ? sys.patch : null, { size_system: "UK" });
  assert("error" in buildPatch("brand_size_charts", { size_system: "US-ish" }));
});
