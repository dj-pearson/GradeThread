// US-2420: the AI only ever sees a capped slice of a category's item-specifics.
// These tests pin WHICH slice: required aspects always survive, and the rest are
// ordered by eBay's own 30-day buyer-search volume rather than by usage tier —
// the bug being fixed is that Theme/Accents/Occasion sit in the OPTIONAL tier
// and were sliced off before the model was ever asked about them.
// Pure functions — no Anthropic/Supabase/env.
//   deno test src/tests/aspect-priority_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  MAX_AI_ASPECTS,
  MAX_ALLOWED_VALUES_PER_ASPECT,
  prioritizeByDemand,
  type RankableRawAspect,
} from "../lib/aspect-priority.ts";

interface Spec {
  name: string;
  required: boolean;
}

const spec = (name: string, required = false): Spec => ({ name, required });

const rawAspect = (
  name: string,
  usage: string,
  searchCount?: number,
  required = false,
): RankableRawAspect => ({
  localizedAspectName: name,
  aspectConstraint: { aspectRequired: required, aspectUsage: usage },
  ...(searchCount === undefined ? {} : { relevanceIndicator: { searchCount } }),
});

const names = (specs: Spec[]) => specs.map((s) => s.name);

// ── The regression this story exists for ────────────────────────────────────

Deno.test("a high-search OPTIONAL aspect beyond the old cap still reaches the schema", () => {
  // 40 filler aspects nobody searches, then Theme — which under the old
  // required → RECOMMENDED → OPTIONAL sort landed at position 41 and was cut.
  const specs: Spec[] = [];
  const raw: RankableRawAspect[] = [];
  for (let i = 0; i < 40; i++) {
    specs.push(spec(`Filler ${String(i).padStart(2, "0")}`));
    raw.push(rawAspect(`Filler ${String(i).padStart(2, "0")}`, "RECOMMENDED", 5));
  }
  specs.push(spec("Theme"));
  raw.push(rawAspect("Theme", "OPTIONAL", 90_000));

  const ranked = prioritizeByDemand(specs, raw);
  assertEquals(ranked[0]!.name, "Theme");
  assert(names(ranked).includes("Theme"));
});

Deno.test("the cap never drops a required aspect, even past the limit", () => {
  const specs: Spec[] = [];
  const raw: RankableRawAspect[] = [];
  for (let i = 0; i < MAX_AI_ASPECTS + 10; i++) {
    const name = `Required ${String(i).padStart(2, "0")}`;
    specs.push(spec(name, true));
    raw.push(rawAspect(name, "REQUIRED", 0, true));
  }
  // One optional aspect with huge demand must NOT displace a required one.
  specs.push(spec("Theme"));
  raw.push(rawAspect("Theme", "OPTIONAL", 999_999));

  const ranked = prioritizeByDemand(specs, raw);
  assertEquals(ranked.length, MAX_AI_ASPECTS + 10);
  assert(ranked.every((s) => s.required));
  assert(!names(ranked).includes("Theme"));
});

Deno.test("required aspects come first and keep eBay's own order", () => {
  const specs = [
    spec("Accents"),
    spec("Size", true),
    spec("Department", true),
  ];
  const raw = [
    rawAspect("Accents", "OPTIONAL", 500_000),
    rawAspect("Size", "REQUIRED", 1, true),
    rawAspect("Department", "REQUIRED", 2, true),
  ];
  assertEquals(names(prioritizeByDemand(specs, raw)), [
    "Size",
    "Department",
    "Accents",
  ]);
});

// ── Ordering rules ──────────────────────────────────────────────────────────

Deno.test("non-required aspects sort by search count, highest first", () => {
  const specs = [spec("Pattern"), spec("Occasion"), spec("Fabric Weight")];
  const raw = [
    rawAspect("Pattern", "RECOMMENDED", 100),
    rawAspect("Occasion", "OPTIONAL", 9_000),
    rawAspect("Fabric Weight", "OPTIONAL", 1_200),
  ];
  assertEquals(names(prioritizeByDemand(specs, raw)), [
    "Occasion",
    "Fabric Weight",
    "Pattern",
  ]);
});

Deno.test("on an equal search count RECOMMENDED beats OPTIONAL", () => {
  const specs = [spec("Accents"), spec("Pattern")];
  const raw = [
    rawAspect("Accents", "OPTIONAL", 400),
    rawAspect("Pattern", "RECOMMENDED", 400),
  ];
  assertEquals(names(prioritizeByDemand(specs, raw)), ["Pattern", "Accents"]);
});

Deno.test("a category with no search counts at all is ordered deterministically", () => {
  const specs = [spec("Style"), spec("Accents"), spec("Pattern")];
  const raw = [
    rawAspect("Style", "OPTIONAL"),
    rawAspect("Accents", "OPTIONAL"),
    rawAspect("Pattern", "OPTIONAL"),
  ];
  // Every key ties, so the name tiebreak decides — same schema, same prompt,
  // same cache key on every run.
  assertEquals(names(prioritizeByDemand(specs, raw)), [
    "Accents",
    "Pattern",
    "Style",
  ]);
});

Deno.test("an aspect missing from the raw payload ranks as zero demand, never dropped", () => {
  const specs = [spec("Mystery"), spec("Theme")];
  const raw = [rawAspect("Theme", "OPTIONAL", 10)];
  assertEquals(names(prioritizeByDemand(specs, raw)), ["Theme", "Mystery"]);
});

Deno.test("a non-array raw payload degrades to name order instead of throwing", () => {
  const specs = [spec("Theme"), spec("Accents")];
  assertEquals(names(prioritizeByDemand(specs, null)), ["Accents", "Theme"]);
  assertEquals(names(prioritizeByDemand(specs, { nope: true })), [
    "Accents",
    "Theme",
  ]);
});

// ── Caps ────────────────────────────────────────────────────────────────────

Deno.test("the cap bounds the result and is shared by both spec-building paths", () => {
  const specs: Spec[] = [];
  const raw: RankableRawAspect[] = [];
  for (let i = 0; i < MAX_AI_ASPECTS + 25; i++) {
    const name = `Aspect ${String(i).padStart(3, "0")}`;
    specs.push(spec(name));
    raw.push(rawAspect(name, "OPTIONAL", i));
  }
  assertEquals(prioritizeByDemand(specs, raw).length, MAX_AI_ASPECTS);
  // Both limits are real numbers other modules import — a zero/undefined here
  // would silently empty the tool schema.
  assert(MAX_AI_ASPECTS > 0);
  assert(MAX_ALLOWED_VALUES_PER_ASPECT > 0);
});

Deno.test("an explicit cap overrides the default", () => {
  const specs = [spec("A"), spec("B"), spec("C")];
  const raw = [
    rawAspect("A", "OPTIONAL", 3),
    rawAspect("B", "OPTIONAL", 2),
    rawAspect("C", "OPTIONAL", 1),
  ];
  assertEquals(names(prioritizeByDemand(specs, raw, 2)), ["A", "B"]);
});
