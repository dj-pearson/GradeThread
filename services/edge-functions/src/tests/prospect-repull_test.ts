// US-2923: correcting a wrong identification without paying to re-identify.
//
// eBay visual search names a style from a silhouette and is confidently wrong
// often enough that US-2758 wrote a table of its failures. The seller standing
// in the shop can SEE that "Commission Pant" is an ABC Pant. This is the seam
// that lets them say so and re-price against the right comps.
//
// The whole decision lives in a pure function so it is tested by reading its
// answer rather than by standing up a route, an AI mock and an eBay mock. What
// matters and is asserted here:
//
//   - a re-pull spends NO AI action, which is the entire reason it exists;
//   - an override that is present but unusable is an ERROR, never a silent
//     fallthrough to the full identify path, because a silent fallthrough
//     charges the seller two AI actions for a typo;
//   - a grade outside the real scale is dropped rather than clamped. Clamping
//     11.0 to 10.0 invents a New-With-Tags reading nobody made.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { parseProspectOverride, MAX_OVERRIDE_TITLE_CHARS } = await import(
  "../lib/prospect-repull.ts"
);

// ── 1. No override: today's path, untouched ─────────────────────────────────

Deno.test("a body with no titleOverride is not a re-pull", () => {
  for (const body of [{}, { costCents: 500 }, { titleOverride: undefined }]) {
    assertEquals(parseProspectOverride(body).kind, "none");
  }
});

Deno.test("a null titleOverride is not a re-pull either", () => {
  assertEquals(parseProspectOverride({ titleOverride: null }).kind, "none");
});

// ── 2. A usable correction ──────────────────────────────────────────────────

Deno.test("a corrected title comes back trimmed and ready to query", () => {
  const out = parseProspectOverride({
    titleOverride: "  Lululemon ABC Pant 32  ",
    brandOverride: " Lululemon ",
    gradeValue: 7.5,
    gradeTier: "good",
  });
  assert(out.kind === "override");
  assertEquals(out.title, "Lululemon ABC Pant 32");
  assertEquals(out.brand, "Lululemon");
  assertEquals(out.gradeValue, 7.5);
  assertEquals(out.gradeTier, "good");
});

Deno.test("brand and grade are all optional - the title alone is a re-pull", () => {
  const out = parseProspectOverride({ titleOverride: "Patagonia Better Sweater" });
  assert(out.kind === "override");
  assertEquals(out.title, "Patagonia Better Sweater");
  assertEquals(out.brand, null);
  assertEquals(out.gradeValue, null);
  assertEquals(out.gradeTier, null);
});

// ── 3. Present but unusable is an ERROR, never a silent full re-identify ────

Deno.test("a blank correction is refused, not quietly turned into a full run", () => {
  for (const bad of ["", "   ", "\n\t "]) {
    const out = parseProspectOverride({ titleOverride: bad });
    assertEquals(
      out.kind,
      "invalid",
      "a blank override must not fall through to the identify path - that " +
        "silently charges two AI actions for what the seller saw as a typo",
    );
  }
});

Deno.test("a non-string correction is refused", () => {
  for (const bad of [42, true, {}, ["a"]]) {
    assertEquals(parseProspectOverride({ titleOverride: bad }).kind, "invalid");
  }
});

Deno.test("an absurdly long correction is refused rather than sent to eBay", () => {
  const out = parseProspectOverride({
    titleOverride: "x".repeat(MAX_OVERRIDE_TITLE_CHARS + 1),
  });
  assertEquals(out.kind, "invalid");
});

Deno.test("a correction exactly at the limit is allowed", () => {
  const out = parseProspectOverride({
    titleOverride: "x".repeat(MAX_OVERRIDE_TITLE_CHARS),
  });
  assertEquals(out.kind, "override");
});

// ── 4. The grade is a hint from the first run, so it is checked, not trusted ─

Deno.test("a grade off the 1-10 scale is DROPPED, never clamped", () => {
  for (const bad of [0, -1, 10.5, 11, 999]) {
    const out = parseProspectOverride({ titleOverride: "Vuori Ponto Pant", gradeValue: bad });
    assert(out.kind === "override");
    assertEquals(
      out.gradeValue,
      null,
      `clamping ${bad} would invent a condition reading nobody made; ` +
        "a null grade prices at the default used bucket, which is honest",
    );
  }
});

Deno.test("a non-numeric or non-finite grade is dropped", () => {
  for (const bad of ["7.5", NaN, Infinity, null, {}]) {
    const out = parseProspectOverride({ titleOverride: "Vuori Ponto Pant", gradeValue: bad });
    assert(out.kind === "override");
    assertEquals(out.gradeValue, null);
  }
});

Deno.test("the scale's own endpoints are accepted", () => {
  for (const good of [1, 1.0, 5.5, 10, 9.5]) {
    const out = parseProspectOverride({ titleOverride: "Faherty Movement Polo", gradeValue: good });
    assert(out.kind === "override");
    assertEquals(out.gradeValue, good);
  }
});

Deno.test("a blank grade tier is dropped rather than stored as an empty label", () => {
  const out = parseProspectOverride({ titleOverride: "Theory Linen Popover", gradeTier: "   " });
  assert(out.kind === "override");
  assertEquals(out.gradeTier, null);
});

// ── 5. The cost claim, stated as a test ─────────────────────────────────────

Deno.test("a re-pull declares that it needs neither identification nor grading", () => {
  const out = parseProspectOverride({ titleOverride: "Lululemon ABC Pant" });
  assert(out.kind === "override");
  assertEquals(
    out.needsIdentify,
    false,
    "the seller supplied the identification - re-deriving it is what this avoids",
  );
  assertEquals(
    out.needsGrade,
    false,
    "the photos did not change, so the grade did not either",
  );
});
