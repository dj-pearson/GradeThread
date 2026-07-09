// US-1746: the pure candidate helpers that decide which auto-seeds get proposed.
// The eBay-backed generateSeeds needs a live stack; the slug/label derivation and
// the dedup+ranking that keep generation idempotent are pure and tested here.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { candidateSlug, candidateLabel, dedupeCandidates, DEFAULT_SEEDGEN_CONFIG } = await import(
  "../lib/condition-index-seedgen.ts"
);

Deno.test("candidateSlug: brand+keyword → curated-shaped slug", () => {
  assertEquals(candidateSlug("Patagonia", "jacket"), "patagonia-jacket");
  assertEquals(candidateSlug("The North Face", "fleece"), "the-north-face-fleece");
  assertEquals(candidateSlug("Levi's", "501 jeans"), "levi-s-501-jeans");
});

Deno.test("candidateLabel: title-cases the keyword", () => {
  assertEquals(candidateLabel("Patagonia", "jacket"), "Patagonia Jacket");
  assertEquals(candidateLabel("Nike", "vintage tee"), "Nike Vintage Tee");
});

Deno.test("dedupeCandidates: drops existing-slug + duplicate candidates, ranks by demand", () => {
  const candidates = [
    { brand: "Patagonia", keyword: "jacket", demand: 5 },
    { brand: "Nike", keyword: "tee", demand: 20 }, // higher demand
    { brand: "Patagonia", keyword: "jacket", demand: 5 }, // dup of the first
    { brand: "Carhartt", keyword: "jacket", demand: 8 },
  ];
  const existing = new Set(["carhartt-jacket"]); // already seeded
  const out = dedupeCandidates(candidates, existing);
  assertEquals(out.map((c) => candidateSlug(c.brand, c.keyword)), ["nike-tee", "patagonia-jacket"]);
});

Deno.test("dedupeCandidates: empty when everything is already seeded", () => {
  const candidates = [{ brand: "Patagonia", keyword: "jacket", demand: 5 }];
  assertEquals(dedupeCandidates(candidates, new Set(["patagonia-jacket"])).length, 0);
});

Deno.test("DEFAULT_SEEDGEN_CONFIG is OFF by default (operator opt-in) and budget-bounded", () => {
  assert(!DEFAULT_SEEDGEN_CONFIG.enabled);
  assert(DEFAULT_SEEDGEN_CONFIG.maxCandidatesPerRun > 0);
  assert(DEFAULT_SEEDGEN_CONFIG.minGradedCount >= 1);
});
