// US-617: ScoutAI arbitrage scoring + ranking (pure).
import { assert, assertEquals } from "@std/assert";
import {
  rankCandidates,
  scoreCandidate,
  SCOUT_MIN_GRADE_CONFIDENCE,
  type ScoutCandidate,
} from "../lib/scout-scoring.ts";
import type { ValueRange } from "../lib/condition-value.ts";

const CAND = (askingCents: number | null): ScoutCandidate => ({
  itemId: "v1|1|0",
  title: "Patagonia Better Sweater",
  imageUrl: null,
  itemWebUrl: "https://ebay.com/itm/1",
  askingCents,
});

const value = (medianCents: number | null, sufficient = true): ValueRange => ({
  lowCents: medianCents == null ? null : medianCents - 1000,
  medianCents,
  highCents: medianCents == null ? null : medianCents + 1000,
  sampleSize: sufficient ? 12 : 1,
  confidence: sufficient ? 0.8 : 0.1,
  sufficient,
  currency: "USD",
});

Deno.test("a clearly underpriced item is actionable + flagged underpriced", () => {
  // Asking $30, condition-adjusted value $80 → net ~$69.6 → big margin.
  const s = scoreCandidate(CAND(3000), 8.5, 0.85, value(8000));
  assertEquals(s.actionable, true);
  assertEquals(s.underpriced, true);
  assert(s.estMarginCents! > 0);
  assert(s.reason.toLowerCase().includes("underpriced"));
});

Deno.test("low grade-confidence is never actionable", () => {
  const s = scoreCandidate(CAND(3000), 8.5, SCOUT_MIN_GRADE_CONFIDENCE - 0.01, value(8000));
  assertEquals(s.actionable, false);
  assert(s.reason.toLowerCase().includes("confidence"));
});

Deno.test("insufficient comps → not actionable, no margin", () => {
  const s = scoreCandidate(CAND(3000), 8.5, 0.9, value(8000, false));
  assertEquals(s.actionable, false);
  assertEquals(s.estMarginCents, null);
  assert(s.reason.toLowerCase().includes("comps"));
});

Deno.test("priced at/above value → margin <= 0, not actionable", () => {
  // Asking $80, value $80 → net $69.6 < asking → negative margin.
  const s = scoreCandidate(CAND(8000), 8.0, 0.9, value(8000));
  assertEquals(s.actionable, false);
  assert(s.estMarginCents! <= 0);
});

Deno.test("missing asking price is handled", () => {
  const s = scoreCandidate(CAND(null), 8.0, 0.9, value(8000));
  assertEquals(s.actionable, false);
  assertEquals(s.estMarginCents, null);
});

Deno.test("ranking puts actionable first, then by margin desc", () => {
  const a = scoreCandidate({ ...CAND(3000), itemId: "a" }, 8.5, 0.9, value(8000)); // big margin, actionable
  const b = scoreCandidate({ ...CAND(6000), itemId: "b" }, 8.5, 0.9, value(8000)); // smaller margin, actionable
  const c = scoreCandidate({ ...CAND(3000), itemId: "c" }, 8.5, 0.2, value(8000)); // not actionable (conf)
  const ranked = rankCandidates([c, b, a]);
  assertEquals(ranked.map((r) => r.itemId), ["a", "b", "c"]);
});
