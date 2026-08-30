import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  parseExtraction,
  parseLines,
  linesReconcile,
  lowConfidenceFields,
  toCents,
  toDate,
  toConfidence,
  encodeBase64,
  RECEIPT_PROMPT_VERSION,
  LOW_CONFIDENCE_THRESHOLD,
} from "../lib/receipt-extract.ts";

// US-2993.
//
// These test the PARSER against the outputs a model actually produces,
// including the wrong ones. Testing only well-formed JSON would test the prompt
// rather than the code, and the prompt is not what breaks at 2am.

const TODAY = new Date(2026, 5, 15);

function reply(obj: unknown): string {
  return JSON.stringify(obj);
}

Deno.test("toCents accepts what models actually return", () => {
  assertEquals(toCents(12.34), 1234);
  assertEquals(toCents("12.34"), 1234);
  // However firmly the prompt says plain numbers.
  assertEquals(toCents("$12.34"), 1234);
  assertEquals(toCents("1,234.56"), 123456);
  assertEquals(toCents(0), 0);
});

Deno.test("toCents rejects a misread rather than passing it on", () => {
  // A negative total or a nine-digit one is a barcode or an order number read
  // as money. Letting it through puts a wrong figure in front of a seller with
  // a confident label on it.
  assertEquals(toCents(-5), null);
  assertEquals(toCents(1e9), null);
  assertEquals(toCents("not a number"), null);
  assertEquals(toCents(null), null);
  assertEquals(toCents(undefined), null);
});

Deno.test("toDate only accepts a plausible receipt date", () => {
  assertEquals(toDate("2026-03-04", TODAY), "2026-03-04");
  // An OCR error on a till number must not put the expense in a year the
  // seller was not trading in.
  assertEquals(toDate("1998-03-04", TODAY), null);
  assertEquals(toDate("2087-03-04", TODAY), null);
  assertEquals(toDate("03/04/2026", TODAY), null);
  assertEquals(toDate("2026-13-04", TODAY), null);
  assertEquals(toDate(20260304, TODAY), null);
  assertEquals(toDate(null, TODAY), null);
});

Deno.test("toDate allows ten years back and one year forward", () => {
  // Ten back covers amending an old return; one forward covers a clock skew or
  // a receipt printed just after midnight on New Year.
  assertEquals(toDate("2016-01-01", TODAY), "2016-01-01");
  assertEquals(toDate("2015-12-31", TODAY), null);
  assertEquals(toDate("2027-01-01", TODAY), "2027-01-01");
  assertEquals(toDate("2028-01-01", TODAY), null);
});

Deno.test("toConfidence clamps and never trusts a missing value", () => {
  assertEquals(toConfidence(0.8), 0.8);
  assertEquals(toConfidence(1.5), 1);
  assertEquals(toConfidence(-1), 0);
  assertEquals(toConfidence("nonsense"), 0);
  assertEquals(toConfidence(undefined), 0);
});

Deno.test("parseExtraction reads a well-formed reply", () => {
  const r = parseExtraction(
    reply({
      vendor: "Goodwill",
      date: "2026-03-04",
      total: 47.83,
      tax: 3.52,
      category: "other",
      lines: [
        { description: "MENS SHIRT", amount: 5.99 },
        { description: "RED ITEM", amount: 3.99 },
      ],
      confidence: { vendor: 0.95, date: 0.9, total: 0.99, tax: 0.8, category: 0.6 },
    }),
    TODAY,
  );
  assertEquals(r.draft.vendor, "Goodwill");
  assertEquals(r.draft.spent_on, "2026-03-04");
  assertEquals(r.draft.total_cents, 4783);
  assertEquals(r.draft.tax_cents, 352);
  assertEquals(r.draft.lines.length, 2);
  assertEquals(r.warning, null);
  assertEquals(r.promptVersion, RECEIPT_PROMPT_VERSION);
});

Deno.test("parseExtraction digs the JSON out of prose and fences", () => {
  // Models wrap it however firmly the prompt asks not to.
  const wrapped =
    "Here is the receipt data:\n```json\n" +
    reply({
      vendor: "Target", date: null, total: 9.99, tax: null,
      category: null, lines: [], confidence: {},
    }) +
    "\n```\nHope that helps.";
  assertEquals(parseExtraction(wrapped, TODAY).draft.total_cents, 999);
});

Deno.test("parseExtraction never throws on rubbish", () => {
  // AC2: a failure degrades to the manual form SAYING SO. A spinner that ends
  // in an empty form teaches the seller the feature is broken.
  for (const bad of ["", "I'm sorry, I can't help with that.", "{not json", "null"]) {
    const r = parseExtraction(bad, TODAY);
    assertEquals(r.draft.total_cents, null);
    assertEquals(typeof r.warning, "string");
  }
});

Deno.test("a field the model could not produce cannot be confident about it", () => {
  // The specific failure this guards: a model returning null and 1.0 together,
  // which would show a seller an empty box marked as certain.
  const r = parseExtraction(
    reply({
      vendor: null,
      date: null,
      total: 10,
      tax: null,
      category: null,
      lines: [],
      confidence: { vendor: 1, date: 1, total: 1, tax: 1, category: 1 },
    }),
    TODAY,
  );
  assertEquals(r.confidence.vendor, 0);
  assertEquals(r.confidence.date, 0);
  assertEquals(r.confidence.tax, 0);
  assertEquals(r.confidence.category, 0);
  // The one it DID read keeps its confidence.
  assertEquals(r.confidence.total, 1);
});

Deno.test("an unreadable total warns, because it is the one field required", () => {
  const r = parseExtraction(
    reply({
      vendor: "Goodwill", date: "2026-03-04", total: null, tax: null,
      category: null, lines: [], confidence: {},
    }),
    TODAY,
  );
  assertEquals(r.draft.total_cents, null);
  assertEquals(r.warning !== null, true);
  // ...and the rest still comes through, so the seller types one number rather
  // than all four.
  assertEquals(r.draft.vendor, "Goodwill");
  assertEquals(r.draft.spent_on, "2026-03-04");
});

Deno.test("an invented category is dropped rather than passed through", () => {
  const r = parseExtraction(
    reply({
      vendor: "X", date: null, total: 5, tax: null,
      category: "groceries", lines: [], confidence: { category: 0.9 },
    }),
    TODAY,
  );
  assertEquals(r.draft.category, null);
  assertEquals(r.confidence.category, 0);
});

Deno.test("parseLines drops a line it cannot price", () => {
  // A $0.00 line would sit in a split looking like a free item and silently
  // take a share of nothing.
  const lines = parseLines([
    { description: "MENS SHIRT", amount: 5.99 },
    { description: "UNREADABLE", amount: null },
    { description: "ZERO", amount: 0 },
    { description: "RED ITEM", amount: "3.99" },
    "not an object",
  ]);
  assertEquals(lines.length, 2);
  assertEquals(lines[0].amount_cents, 599);
  assertEquals(lines[1].amount_cents, 399);
});

Deno.test("parseLines keeps a useless description verbatim", () => {
  // "RED ITEM" is what the receipt says. Tidying it into "Red clothing item"
  // would be a guess, and US-3012 matches on PRICE anyway.
  const lines = parseLines([{ description: "  RED ITEM  ", amount: 3.99 }]);
  assertEquals(lines[0].description, "RED ITEM");
});

Deno.test("parseLines caps a runaway list", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    description: `L${i}`,
    amount: 1,
  }));
  assertEquals(parseLines(many).length, 60);
});

Deno.test("parseLines survives anything that is not a list", () => {
  assertEquals(parseLines(null), []);
  assertEquals(parseLines("lines"), []);
  assertEquals(parseLines({}), []);
});

Deno.test("linesReconcile says whether a split can be trusted", () => {
  // US-3012 refuses to split when this is not roughly zero: a receipt read
  // partially would allocate the wrong cost to every item.
  const good = parseExtraction(
    reply({
      vendor: "Goodwill", date: null, total: 13.5, tax: 1.0, category: null,
      lines: [{ description: "A", amount: 6.5 }, { description: "B", amount: 6.0 }],
      confidence: {},
    }),
    TODAY,
  );
  assertEquals(linesReconcile(good.draft), 0);

  const partial = parseExtraction(
    reply({
      vendor: "Goodwill", date: null, total: 47.83, tax: 0, category: null,
      lines: [{ description: "A", amount: 5.99 }],
      confidence: {},
    }),
    TODAY,
  );
  // Off by the lines the model never read.
  assertEquals(linesReconcile(partial.draft), 4184);
});

Deno.test("linesReconcile is null when it cannot tell", () => {
  const noTotal = parseExtraction(
    reply({
      vendor: null, date: null, total: null, tax: null, category: null,
      lines: [{ description: "A", amount: 1 }], confidence: {},
    }),
    TODAY,
  );
  assertEquals(linesReconcile(noTotal.draft), null);

  const noLines = parseExtraction(
    reply({
      vendor: null, date: null, total: 10, tax: null, category: null,
      lines: [], confidence: {},
    }),
    TODAY,
  );
  assertEquals(linesReconcile(noLines.draft), null);
});

Deno.test("lowConfidenceFields flags only fields that HAVE a value", () => {
  // AC3. A field the model produced nothing for shows as an empty input, which
  // already says everything a warning would; flagging it too is noise.
  const r = parseExtraction(
    reply({
      vendor: "Goodwill",
      date: "2026-03-04",
      total: 47.83,
      tax: null,
      category: null,
      lines: [],
      confidence: { vendor: 0.95, date: 0.4, total: 0.99, tax: 0.2, category: 0.1 },
    }),
    TODAY,
  );
  assertEquals(lowConfidenceFields(r), ["date"]);
});

Deno.test("the low-confidence threshold matches the grading pipeline's", () => {
  // Two different numbers for "not sure enough" in one product is one number
  // nobody can explain.
  assertEquals(LOW_CONFIDENCE_THRESHOLD, 0.75);
});

Deno.test("encodeBase64 handles a photo-sized buffer", () => {
  // The naive one-concatenation-per-byte loop the rest of the codebase uses is
  // fine for a signature and not for ten megabytes; the spread version without
  // chunking throws on large inputs. This is the size a phone photo actually is.
  const big = new Uint8Array(2_000_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  const encoded = encodeBase64(big);
  assertEquals(typeof encoded, "string");
  assertEquals(encoded.length > 2_600_000, true);
  // Round-trips.
  const back = atob(encoded);
  assertEquals(back.length, big.length);
  assertEquals(back.charCodeAt(0), 0);
  assertEquals(back.charCodeAt(255), 255);
});
