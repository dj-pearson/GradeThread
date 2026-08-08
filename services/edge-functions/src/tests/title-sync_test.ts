// US-1891: backwards title sync — pure substitution unit tests.
import { assert, assertEquals } from "@std/assert";
import {
  applyTitleSubstitution,
  changesFromItemDiff,
  syncTitle,
  titleNeedsSync,
  type FieldChange,
} from "../lib/title-sync.ts";

// ── brand swap ─────────────────────────────────────────────────────

Deno.test("swaps a single-word brand", () => {
  assertEquals(
    applyTitleSubstitution("Nike Air Max Mens Sneakers Size 11", "Nike", "Adidas"),
    "Adidas Air Max Mens Sneakers Size 11",
  );
});

Deno.test("swaps a multi-word brand", () => {
  assertEquals(
    applyTitleSubstitution("The North Face Puffer Jacket Black L", "The North Face", "Patagonia"),
    "Patagonia Puffer Jacket Black L",
  );
});

Deno.test("brand swap is case-insensitive but transfers ALL-CAPS", () => {
  assertEquals(
    applyTitleSubstitution("NIKE tee size m", "Nike", "Adidas"),
    "ADIDAS tee size m",
  );
});

Deno.test("does not match a brand inside another word", () => {
  // "Nike" must not fire inside "Nikeish".
  assertEquals(
    applyTitleSubstitution("Nikeish knockoff tee", "Nike", "Adidas"),
    "Nikeish knockoff tee",
  );
});

// ── size swap (Size L / Sz L / bare token) ─────────────────────────

Deno.test("swaps a bare size token but not inside XL", () => {
  assertEquals(
    applyTitleSubstitution("Nike Hoodie L Fleece", "L", "M"),
    "Nike Hoodie M Fleece",
  );
  assertEquals(
    applyTitleSubstitution("Nike Hoodie XL Fleece", "L", "M"),
    "Nike Hoodie XL Fleece",
  );
});

Deno.test("swaps size in 'Size L' and 'Sz L' shapes", () => {
  assertEquals(applyTitleSubstitution("Dress Size L Blue", "L", "M"), "Dress Size M Blue");
  assertEquals(applyTitleSubstitution("Dress Sz L Blue", "L", "M"), "Dress Sz M Blue");
});

// ── no-op contract ─────────────────────────────────────────────────

Deno.test("no-op when the old value isn't present", () => {
  const t = "Adidas Track Jacket Green M";
  assertEquals(applyTitleSubstitution(t, "Nike", "Puma"), t);
});

Deno.test("no-op when from == to (case-insensitively) or empty", () => {
  assertEquals(applyTitleSubstitution("Nike Tee", "Nike", "nike"), "Nike Tee");
  assertEquals(applyTitleSubstitution("Nike Tee", "", "Puma"), "Nike Tee");
  assertEquals(applyTitleSubstitution("Nike Tee", "Nike", ""), "Nike Tee");
});

// ── color / style / department ─────────────────────────────────────

Deno.test("swaps color and style values", () => {
  assertEquals(applyTitleSubstitution("Levi 501 Blue Denim", "Blue", "Black"), "Levi 501 Black Denim");
  assertEquals(applyTitleSubstitution("Boho Maxi Dress", "Boho", "Cottagecore"), "Cottagecore Maxi Dress");
});

// ── syncTitle (batch + re-trim) ────────────────────────────────────

Deno.test("applies multiple changes in order", () => {
  const out = syncTitle("Nike Tee Blue M", [
    { field: "brand", from: "Nike", to: "Adidas" },
    { field: "color", from: "Blue", to: "Red" },
  ]);
  assertEquals(out, "Adidas Tee Red M");
});

Deno.test("re-trims to 80 chars after a longer brand name (AC5)", () => {
  // 78-char title; brand grows by 8 chars → would be 86 → trimmed on a word
  // boundary back under 80, dropping the lowest-priority trailing word.
  const title = "Nike Mens Running Sneakers Size 11 White Black Leather Athletic Shoes Pair";
  assert(title.length <= 80);
  const out = syncTitle(title, [
    { field: "brand", from: "Nike", to: "Under Armour" },
  ]);
  assert(out.length <= 80, `expected <=80, got ${out.length}: ${out}`);
  assert(out.startsWith("Under Armour Mens Running"));
});

Deno.test("titleNeedsSync detects a real change vs a no-op", () => {
  assert(titleNeedsSync("Nike Tee M", [{ from: "Nike", to: "Adidas" }]));
  assert(!titleNeedsSync("Nike Tee M", [{ from: "Puma", to: "Adidas" }]));
});

// ── changesFromItemDiff ────────────────────────────────────────────

Deno.test("changesFromItemDiff keeps only changed syncable fields", () => {
  const before = { brand: "Nike", size: "L", color: "Blue", style: "Retro", department: "Men", title: "x" };
  const after = { brand: "Adidas", size: "L", color: "Red", style: "Retro", department: "Men", title: "y" };
  const changes = changesFromItemDiff(before, after);
  assertEquals(changes.map((c) => c.field).sort(), ["brand", "color"]);
});

Deno.test("changesFromItemDiff ignores empty/whitespace transitions", () => {
  const before = { brand: "", size: "L" };
  const after = { brand: "  ", size: "M" };
  const changes = changesFromItemDiff(before, after);
  assertEquals(changes.map((c) => c.field), ["size"]);
});

// ── shared behavioural fixture (US-1995 AC4) ───────────────────────────────
//
// This logic exists TWICE — here and in src/lib/title-sync.ts — because the
// edge and the web app are separate projects that cannot import each other.
// They are declared to stay in lockstep and nothing pinned them. A source diff
// cannot be the guard: the two files differ by ~80 lines, much of it legitimate
// (the web copy inlines the trim because it cannot import title-trim.ts).
//
// So the guard is behavioural. Both suites read the SAME fixture and assert the
// same inputs produce the same outputs. Add a case to the fixture, never to one
// suite.
const FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/title-sync-cases.json", import.meta.url),
  ),
) as {
  syncTitle: { name: string; title: string; changes: FieldChange[]; expected: string }[];
  idempotent: { name: string; title: string; changes: FieldChange[]; expected: string }[];
  changesFromItemDiff: {
    name: string;
    before: Record<string, string>;
    after: Record<string, string>;
    expected: FieldChange[];
  }[];
};

Deno.test("shared fixture: syncTitle matches the web copy's expectations", () => {
  assert(FIXTURE.syncTitle.length > 0, "fixture is empty — wrong path?");
  for (const c of FIXTURE.syncTitle) {
    assertEquals(syncTitle(c.title, c.changes), c.expected, `fixture case: ${c.name}`);
  }
});

// US-1995 AC2. Asserted by applying the changes TWICE, because that is the shape
// the bug takes in production: `changes` comes from a captured before-map, so a
// retried mutation or a stale query cache replays the same {from, to} against a
// title that already holds the new value.
Deno.test("shared fixture: syncTitle is idempotent — twice equals once", () => {
  assert(FIXTURE.idempotent.length > 0, "fixture is empty — wrong path?");
  for (const c of FIXTURE.idempotent) {
    const once = syncTitle(c.title, c.changes);
    assertEquals(once, c.expected, `fixture case: ${c.name} (first pass)`);
    assertEquals(syncTitle(once, c.changes), c.expected, `fixture case: ${c.name} (second pass)`);
  }
});

Deno.test("shared fixture: changesFromItemDiff matches the web copy's expectations", () => {
  assert(FIXTURE.changesFromItemDiff.length > 0, "fixture is empty — wrong path?");
  for (const c of FIXTURE.changesFromItemDiff) {
    assertEquals(changesFromItemDiff(c.before, c.after), c.expected, `fixture case: ${c.name}`);
  }
});
