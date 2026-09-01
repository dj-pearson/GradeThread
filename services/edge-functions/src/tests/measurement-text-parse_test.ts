// US-3035: the listing-text parser, and the fixture that is the real
// deliverable of this story.
//
// This parser is the component most likely to be quietly wrong, and a silent
// defect here is indistinguishable from real data once it lands. So the fixture
// below is written from how resellers actually type, not from how a parser
// author wishes they typed: fractions off a tape measure, several measurements
// crammed onto one line, centimetres, tables flattened out of HTML, and prose
// full of numbers that mean nothing.
//
// The asymmetry that decides every case: a measurement that never arrives costs
// one sample out of a cohort, and a wrong one moves a published median with
// nothing downstream to catch it. Every ambiguous case must DROP.
//
//   deno test --allow-env --allow-read src/tests/measurement-text-parse_test.ts

import { assert, assertEquals } from "@std/assert";

const {
  parseMeasurementsFromText,
  parseSellerNumber,
  MEASUREMENT_SANITY_BANDS,
  LISTING_TEXT_CONFIDENCE,
} = await import("../lib/measurement-text-parse.ts");
const { htmlToPlainText } = await import("../lib/cert-description.ts");
const { MEASUREMENT_TEMPLATES } = await import("../lib/measurement-templates.ts");

/** Convenience: field -> inches, for asserting on a whole parse at once. */
function parsed(text: string, group: "top" | "bottom" | "outerwear" | "dress") {
  const out: Record<string, number> = {};
  for (const m of parseMeasurementsFromText(text, group)) out[m.key] = m.inches;
  return out;
}

// ── What it must READ ───────────────────────────────────────────────────────

Deno.test("US-3035 fixture: the ordinary shapes a reseller types", () => {
  assertEquals(parsed(`Pit to pit: 22"`, "top"), { chest: 22 });
  assertEquals(parsed(`Chest 22 in`, "top"), { chest: 22 });
  assertEquals(parsed(`Inseam - 32 inches`, "bottom"), { inseam: 32 });
  assertEquals(parsed(`Length: 29.5"`, "top"), { length: 29.5 });
  assertEquals(parsed(`Waist (flat): 17"`, "bottom"), { waist: 17 });
  assertEquals(parsed(`P2P 21in`, "top"), { chest: 21 });
  assertEquals(parsed(`Armpit to armpit is 23 inches`, "top"), { chest: 23 });
  assertEquals(parsed(`SHOULDER TO SHOULDER: 18"`, "top"), { shoulder: 18 });
});

Deno.test("US-3035 fixture: fractions, because a tape measure is marked in eighths", () => {
  assertEquals(parsed(`Pit to pit: 22 1/2"`, "top"), { chest: 22.5 });
  assertEquals(parsed(`Waist 16 3/4 in`, "bottom"), { waist: 16.75 });
  assertEquals(parsed(`Inseam 31 1/8"`, "bottom"), { inseam: 31.13 });
  assertEquals(parseSellerNumber("22 1/2"), 22.5);
  assertEquals(parseSellerNumber("3/4"), 0.75);
  assertEquals(parseSellerNumber("22.5"), 22.5);
  assert(Number.isNaN(parseSellerNumber("twenty two")));
  assert(Number.isNaN(parseSellerNumber("22/0")));
});

Deno.test("US-3035 fixture: several measurements crammed onto one line", () => {
  assertEquals(
    parsed(`Chest: 22" / Length: 29" / Sleeve: 25"`, "top"),
    { chest: 22, length: 29, sleeve: 25 },
  );
  assertEquals(
    parsed(`Waist 17in, Inseam 32in, Rise 11in, Leg opening 8in`, "bottom"),
    { waist: 17, inseam: 32, rise: 11, leg_opening: 8 },
  );
});

Deno.test("US-3035 fixture: centimetres are converted, and ONLY when written", () => {
  assertEquals(parsed(`Chest 56 cm`, "top"), { chest: 22.05 });
  assertEquals(parsed(`Chest 56cm`, "top"), { chest: 22.05 });
  // The same number with no unit is refused rather than assumed to be either.
  assertEquals(parsed(`Chest 56`, "top"), {});
});

Deno.test("US-3035 fixture: an HTML table flattened by htmlToPlainText", () => {
  // eBay bodies are HTML, and listings.listing_description stores them that
  // way. The parser runs on the flattened text, so the two have to work
  // together or the whole source is unreadable.
  const html = `
    <div><h2>Measurements</h2>
    <table><tbody>
      <tr><td>Pit to pit</td><td>23&quot;</td></tr>
      <tr><td>Length</td><td>30 1/2&quot;</td></tr>
      <tr><td>Sleeve</td><td>26&quot;</td></tr>
    </tbody></table>
    <p>Smoke free home!</p></div>`;
  assertEquals(
    parsed(htmlToPlainText(html), "top"),
    { chest: 23, length: 30.5, sleeve: 26 },
  );
});

// ── What it must REFUSE ─────────────────────────────────────────────────────

Deno.test("US-3035: a bare number with no unit is refused", () => {
  // "chest 22" as often means a size as a measurement, and there is no way to
  // tell from the text which one a seller meant.
  assertEquals(parsed(`Chest 22`, "top"), {});
  assertEquals(parsed(`Waist 32`, "bottom"), {});
  assertEquals(parsed(`Size 22 chest 22`, "top"), {});
});

Deno.test("US-3035: a RANGE is refused rather than averaged", () => {
  // The seller declined to commit to a number. Picking one for them invents
  // precision they deliberately withheld.
  assertEquals(parsed(`Chest 22-23"`, "top"), {});
  assertEquals(parsed(`Chest 22 to 23 inches`, "top"), {});
  assertEquals(parsed(`Waist 30 - 32 in`, "bottom"), {});
});

Deno.test("US-3035: a value outside its sanity band is DROPPED, never clamped", () => {
  // Clamping would turn a typo into a plausible wrong number, which is the
  // worst available outcome: it survives every downstream check.
  assertEquals(parsed(`Chest 220"`, "top"), {});
  assertEquals(parsed(`Chest 2"`, "top"), {});
  assertEquals(parsed(`Inseam 320 in`, "bottom"), {});
  // And the near-miss on the correct side still reads.
  assertEquals(parsed(`Chest 39"`, "top"), { chest: 39 });
});

Deno.test("US-3035: prose full of numbers yields nothing", () => {
  const prose = `
    Bought this in 2019 for $120. Worn maybe 3 times. Ships within 24 hours.
    Check out my other 15 listings! 100% authentic. Bundle 2 items and save 10%.
    Measurements available on request.`;
  assertEquals(parsed(prose, "top"), {});
  assertEquals(parsed(prose, "bottom"), {});
});

Deno.test("US-3035: a field that does not belong to the group is not read", () => {
  // Inseam on a t-shirt is either a mistake or a different garment. Either way
  // it must not land in the top cohort.
  assertEquals(parsed(`Inseam 32"`, "top"), {});
  assertEquals(parsed(`Pit to pit 22"`, "bottom"), {});
});

Deno.test("US-3035: a repeated field keeps the first and ignores the second", () => {
  // A description that states the chest twice repeated itself, and there is no
  // principled way to choose. Taking the first is arbitrary but stable; taking
  // the last would make the answer depend on where the seller put their
  // boilerplate.
  assertEquals(parsed(`Chest: 22". Again, chest 25".`, "top"), { chest: 22 });
});

Deno.test("US-3035: empty and junk input never throws", () => {
  assertEquals(parseMeasurementsFromText(null, "top"), []);
  assertEquals(parseMeasurementsFromText(undefined, "top"), []);
  assertEquals(parseMeasurementsFromText("", "top"), []);
  assertEquals(parseMeasurementsFromText("<<<>>>", "top"), []);
  assertEquals(parseMeasurementsFromText(`"""""`, "top"), []);
});

// ── Structural guards ───────────────────────────────────────────────────────

Deno.test("US-3035: every length field in every template has a sanity band", () => {
  // A field with no band is silently unparseable — the loop hits `if (!band)
  // continue` and the measurement vanishes with no error. That reads exactly
  // like "sellers never write this one down".
  const missing: string[] = [];
  for (const [group, fields] of Object.entries(MEASUREMENT_TEMPLATES)) {
    for (const f of fields) {
      if (f.unit !== "length") continue;
      if (!(f.key in MEASUREMENT_SANITY_BANDS)) missing.push(`${group}.${f.key}`);
    }
  }
  assertEquals(missing, [], "length fields with no sanity band");
});

Deno.test("US-3035: every sanity band is a real ordered range", () => {
  for (const [key, band] of Object.entries(MEASUREMENT_SANITY_BANDS)) {
    assert(band[0] > 0, `${key} lower bound must be positive`);
    assert(band[1] > band[0], `${key} band must be ordered`);
  }
});

Deno.test("US-3035: parsed text ranks below a calibrated measurement", () => {
  // The ordering is the contract, not the number: a hand-tape measurement in a
  // description is real evidence, and it is not a card-plane measurement.
  assert(LISTING_TEXT_CONFIDENCE < 0.9, "must rank below MeasureCard");
  assert(LISTING_TEXT_CONFIDENCE >= 0.5, "must clear MIN_INGEST_CONFIDENCE");
});
