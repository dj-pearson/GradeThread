// US-2246: the learned style-code → product index.
//
// The rules under test are the ones that keep a self-taught index from hardening
// a guess into a fact:
//   1. Codes normalize so "lw7d-vcs" and "LW7D VCS" are one code, and a code too
//      short to be an identity is not recorded at all.
//   2. Confidence rises with confirmations and is CAPPED below a verified
//      decoder hit, so repetition alone can never win.
//   3. A tie between two attested titles yields NOTHING — two answers for one
//      code means we do not know the product.
//   4. A learned hint never overrides a decoder, and never an equal-or-more
//      confident existing suggestion.
//   5. Only public listing text is carried, and a failed write is swallowed.
//
//   deno test --allow-env --allow-read src/tests/style-code-observations_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  LEARNED_CONFIDENCE_CAP,
  MAX_TITLES_PER_OBSERVATION,
  learnedConfidence,
  normalizeStyleCode,
  pickLearnedStyle,
  recordStyleCodeObservations,
  styleNameFromTitle,
} = await import("../lib/style-code-observations.ts");

const { applyLearnedStyle, LEARNED_SOURCE } = await import(
  "../lib/ai-extract.ts"
);

// ── 1. Normalizing ──────────────────────────────────────────────────────────

Deno.test("normalizeStyleCode collapses case and punctuation to one comparable form", () => {
  const forms = ["LW7DVCS", "lw7d-vcs", "LW7D VCS", " lw7dvcs ", "LW7D/VCS"];
  const keys = new Set(forms.map(normalizeStyleCode));
  assertEquals(keys.size, 1);
  assertEquals([...keys][0], "LW7DVCS");
  assertEquals(normalizeStyleCode(null), "");
  assertEquals(normalizeStyleCode("---"), "");
});

// ── 2. Confidence ───────────────────────────────────────────────────────────

Deno.test("learnedConfidence rises with confirmations and stops at the cap", () => {
  assert(learnedConfidence(1) < learnedConfidence(3));
  assert(learnedConfidence(3) < learnedConfidence(8));
  // The whole point: no number of sightings reaches a verified decoder hit.
  for (const n of [1, 5, 50, 5000]) {
    assert(
      learnedConfidence(n) <= LEARNED_CONFIDENCE_CAP,
      `${n} confirmations must not exceed the cap`,
    );
  }
  assertEquals(learnedConfidence(9999), LEARNED_CONFIDENCE_CAP);
  // A nonsense count still yields a floor, never NaN or a negative.
  assert(learnedConfidence(0) > 0);
});

// ── 3. Writing ──────────────────────────────────────────────────────────────

type Written = {
  brandKey: string;
  styleCodeNorm: string;
  styleCodeRaw: string;
  productTitle: string;
  source: string;
  evidenceUrl: string | null;
};

// ── US-2714: one garment, one key ───────────────────────────────────────────

Deno.test("US-2714: every spelling of one code canonicalizes to one key", async () => {
  const { canonicalStyleCode } = await import("../lib/style-code-observations.ts");
  // The four ways the same Lululemon garment reaches us, plus punctuation and
  // case, plus the 2019+ generation whose season suffix is not part of identity.
  for (
    const spelling of ["W7DVCS", "LW7DVCS", "lw7d-vcs", "LW7D VCS", "W7DVCSP60417"]
  ) {
    assertEquals(canonicalStyleCode("lululemon", spelling), "W7DVCS", spelling);
  }
  assertEquals(canonicalStyleCode("lululemon", "WA1234B.0322"), "WA1234B");
  assertEquals(canonicalStyleCode("lululemon", "LWA1234B.0119"), "WA1234B");
});

Deno.test("US-2714: a brand with no canonical rule is untouched", async () => {
  const { canonicalStyleCode, normalizeStyleCode } = await import(
    "../lib/style-code-observations.ts"
  );
  // Every brand but Lululemon today. The fallback must be exactly what the
  // index used before, or this change silently re-keys the whole corpus.
  for (const raw of ["511-0011", "GY7434", "  es5331 "]) {
    assertEquals(canonicalStyleCode("levis", raw), normalizeStyleCode(raw));
    assertEquals(canonicalStyleCode("", raw), normalizeStyleCode(raw));
  }
  // A Lululemon code that matches no decoder also falls back rather than
  // returning nothing.
  assertEquals(canonicalStyleCode("lululemon", "ABCDEFG"), "ABCDEFG");
  assertEquals(canonicalStyleCode("lululemon", null), "");
});

Deno.test("a confirmed code keeps the title and cites the listing URL", async () => {
  const rows: Written[] = [];
  const n = await recordStyleCodeObservations({
    brandKey: "lululemon",
    styleCodeRaw: "lw7d-vcs",
    titles: [{
      title: "Lululemon ABC Pant Classic 32 Warpstreme",
      url: "https://ebay.com/itm/1",
    }],
    write: (o) => {
      rows.push(o as Written);
      return Promise.resolve();
    },
  });
  assertEquals(n, 1);
  // US-2714: filed under the CANONICAL spelling, not the transcribed one. The
  // decoder reads "lw7d-vcs" as the Lululemon style number W7DVCS behind an L
  // brand prefix, so this row now meets the ones written for "LW7DVCS" and
  // "W7DVCSP60417" instead of sitting in a bucket of its own.
  assertEquals(rows[0]!.styleCodeNorm, "W7DVCS");
  // The raw form is still kept verbatim, for display.
  assertEquals(rows[0]!.styleCodeRaw, "lw7d-vcs");
  assertEquals(rows[0]!.source, "market_verify");
  assertEquals(rows[0]!.evidenceUrl, "https://ebay.com/itm/1");
});

Deno.test("a code too short to be an identity is never recorded", async () => {
  for (const code of ["", null, "AB", "1-2"]) {
    const rows: Written[] = [];
    const n = await recordStyleCodeObservations({
      brandKey: "nike",
      styleCodeRaw: code,
      titles: [{ title: "Nike Dri-Fit Running Shirt Large" }],
      write: (o) => {
        rows.push(o as Written);
        return Promise.resolve();
      },
    });
    assertEquals(n, 0, `${JSON.stringify(code)} must not be recorded`);
    assertEquals(rows.length, 0);
  }
});

Deno.test("one search is one piece of evidence — titles are capped and deduped", async () => {
  const rows: Written[] = [];
  const titles = [
    { title: "Lululemon ABC Pant Classic 32" },
    { title: "lululemon abc pant classic 32" }, // same title, different case
    { title: "Lululemon ABC Pant Slim 34" },
    { title: "Lululemon ABC Jogger 30" },
    { title: "Lululemon ABC Short 9 inch" },
    { title: "Lululemon Commission Pant 32" },
  ];
  const n = await recordStyleCodeObservations({
    brandKey: "lululemon",
    styleCodeRaw: "LW7DVCS",
    titles,
    write: (o) => {
      rows.push(o as Written);
      return Promise.resolve();
    },
  });
  assertEquals(n, MAX_TITLES_PER_OBSERVATION);
  assertEquals(new Set(rows.map((r) => r.productTitle.toLowerCase())).size, n);
});

Deno.test("a title too short to name a product is skipped", async () => {
  const rows: Written[] = [];
  await recordStyleCodeObservations({
    brandKey: "nike",
    styleCodeRaw: "CW2288",
    titles: [{ title: "shirt" }, { title: "  " }],
    write: (o) => {
      rows.push(o as Written);
      return Promise.resolve();
    },
  });
  assertEquals(rows.length, 0);
});

Deno.test("a failed write is swallowed — learning never breaks extraction", async () => {
  const n = await recordStyleCodeObservations({
    brandKey: "nike",
    styleCodeRaw: "CW2288",
    titles: [{ title: "Nike Air Max 90 Infrared" }],
    write: () => Promise.reject(new Error("pg down")),
  });
  assertEquals(n, 0);
});

// ── 4. Reading back ─────────────────────────────────────────────────────────

Deno.test("the most-confirmed title wins", () => {
  const learned = pickLearnedStyle([
    { product_title: "ABC Pant Classic", seen_count: 5, evidence_url: "u1" },
    { product_title: "Commission Pant", seen_count: 2, evidence_url: "u2" },
  ]);
  assertEquals(learned?.productTitle, "ABC Pant Classic");
  assertEquals(learned?.seenCount, 5);
  assertEquals(learned?.confidence, learnedConfidence(5));
});

Deno.test("a tie yields NOTHING — two answers for one code is not an answer", () => {
  const learned = pickLearnedStyle([
    { product_title: "ABC Pant Classic", seen_count: 3, evidence_url: null },
    { product_title: "Commission Pant", seen_count: 3, evidence_url: null },
  ]);
  assertEquals(learned, null);
});

Deno.test("no observations yields nothing rather than a guess", () => {
  assertEquals(pickLearnedStyle([]), null);
});

// ── 5. Turning a listing title into a style name ────────────────────────────

Deno.test("styleNameFromTitle strips the brand, the code and listing chatter", () => {
  const name = styleNameFromTitle(
    "NWT Lululemon ABC Pant Classic LW7DVCS Mens 32x34 Free Shipping",
    "Lululemon",
    "LW7DVCS",
  );
  assertEquals(name, "ABC Pant Classic");
});

Deno.test("styleNameFromTitle keeps model numbers — they ARE the product", () => {
  const name = styleNameFromTitle(
    "Levi's 501 Original Fit Jeans Mens 32x34",
    "Levi's",
    "005010193",
  );
  assert(name!.includes("501"));
});

Deno.test("styleNameFromTitle refuses a one-word remnant", () => {
  assertEquals(styleNameFromTitle("Nike Mens Large NWT", "Nike", "CW2288"), null);
});

// ── 6. Precedence — the safety property ─────────────────────────────────────

function decodedWith(style?: {
  value: string;
  confidence: number;
  source: string;
}) {
  return {
    suggestions: style ? { style } : {},
    attributes: {},
    conflicts: [],
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("a learned hint fills an EMPTY style", () => {
  const out = applyLearnedStyle(decodedWith(), {
    styleName: "ABC Pant Classic",
    confidence: 0.4,
  });
  assertEquals(out.suggestions.style?.value, "ABC Pant Classic");
  assertEquals(out.suggestions.style?.source, LEARNED_SOURCE);
});

Deno.test("a learned hint NEVER overrides a decoder style", () => {
  const decoded = decodedWith({
    value: "Commission Pant",
    // Deliberately LOW, to prove the rule is about provenance, not confidence.
    confidence: 0.1,
    source: "decoder",
  });
  const out = applyLearnedStyle(decoded, {
    styleName: "ABC Pant Classic",
    confidence: LEARNED_CONFIDENCE_CAP,
  });
  assertEquals(out.suggestions.style?.value, "Commission Pant");
  assertEquals(out.suggestions.style?.source, "decoder");
});

Deno.test("an equal-or-more confident existing suggestion wins", () => {
  for (const conf of [0.4, 0.9]) {
    const out = applyLearnedStyle(
      decodedWith({ value: "Research Style", confidence: conf, source: "research" }),
      { styleName: "Learned Style", confidence: 0.4 },
    );
    assertEquals(out.suggestions.style?.value, "Research Style");
  }
});

Deno.test("a weaker existing suggestion is improved rather than kept", () => {
  const out = applyLearnedStyle(
    decodedWith({ value: "Guessed Style", confidence: 0.2, source: "photo" }),
    { styleName: "Learned Style", confidence: 0.45 },
  );
  assertEquals(out.suggestions.style?.value, "Learned Style");
  assertEquals(out.suggestions.style?.source, LEARNED_SOURCE);
});

Deno.test("no learned hit leaves the extraction byte-for-byte unchanged", () => {
  const decoded = decodedWith({
    value: "Existing",
    confidence: 0.3,
    source: "photo",
  });
  assertEquals(applyLearnedStyle(decoded, null), decoded);
  assertEquals(
    applyLearnedStyle(decoded, { styleName: "   ", confidence: 0.5 }),
    decoded,
  );
});
