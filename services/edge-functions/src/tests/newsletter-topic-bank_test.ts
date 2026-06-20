import { assert, assertEquals } from "@std/assert";
import {
  bankRowToTopic,
  computeBankWeights,
  type CoverageContext,
  type EmailTopicBankRow,
  filterAvailableTopics,
  needsRefill,
  normalizeBankRow,
  normalizeRefillCandidate,
  parseRefillCandidates,
  pickBankTopic,
  selectFromBank,
  topicKey,
} from "../lib/newsletter-topic-bank.ts";

// US-917: the topic-bank selection / dedup / refill-parsing logic is pure — no
// supabase/env — so it tests directly (mirrors newsletter-tuning_test.ts).

function row(over: Partial<EmailTopicBankRow> = {}): EmailTopicBankRow {
  return {
    id: over.id ?? `${over.pillar ?? "grading"}-${over.angle ?? "education"}`,
    pillar: "grading",
    angle: "education",
    label: "How condition grading works",
    summary: "",
    key_points: [],
    product_focus: "both",
    status: "active",
    source: "seed",
    last_used_at: null,
    use_count: 0,
    ...over,
  };
}

function ctx(over: Partial<CoverageContext> = {}): CoverageContext {
  return {
    cutoffIso: "2026-01-01T00:00:00.000Z",
    coveredTopicKeys: new Set<string>(),
    coveredLabels: new Set<string>(),
    ...over,
  };
}

// ── normalize ────────────────────────────────────────────────────────────────
Deno.test("normalizeBankRow rejects rows missing identity, coerces defaults", () => {
  assertEquals(normalizeBankRow({ pillar: "p", angle: "a" }), null); // no id/label
  const ok = normalizeBankRow({
    id: "x",
    pillar: "grading",
    angle: "education",
    label: "Lesson",
    product_focus: "weird",
    status: "bogus",
    key_points: ["a", "", " b "],
    use_count: -3,
  });
  assert(ok);
  assertEquals(ok.product_focus, "both"); // invalid focus → both
  assertEquals(ok.status, "active"); // invalid status → active
  assertEquals(ok.key_points, ["a", "b"]); // trimmed + empties dropped
  assertEquals(ok.use_count, 0); // clamped non-negative
});

// ── AC3: dedup against window / sent issues / history ──────────────────────────
Deno.test("filterAvailableTopics excludes recently-used, covered-key, and covered-label rows", () => {
  const rows = [
    row({ id: "fresh", pillar: "pricing", angle: "comps", label: "Comps" }),
    row({ id: "recent", pillar: "grading", angle: "standards", label: "Scale", last_used_at: "2026-02-01T00:00:00.000Z" }),
    row({ id: "sent", pillar: "photography", angle: "basics", label: "Photos" }),
    row({ id: "history", pillar: "trust", angle: "certificates", label: "Certificates" }),
    row({ id: "retired", pillar: "market", angle: "trends", label: "Trends", status: "retired" }),
  ];
  const available = filterAvailableTopics(
    rows,
    ctx({
      cutoffIso: "2026-01-15T00:00:00.000Z", // 'recent' last_used after this → excluded
      coveredTopicKeys: new Set([topicKey("photography", "basics")]),
      coveredLabels: new Set(["certificates"]),
    }),
  );
  assertEquals(available.map((r) => r.id), ["fresh"]);
});

// ── AC2/AC3: full selection picks deduped angle, deterministic + biased ─────────
Deno.test("selectFromBank returns a deduped, deterministic selection", () => {
  const rows = [
    row({ id: "a", pillar: "grading", angle: "education", label: "Grading" }),
    row({ id: "b", pillar: "pricing", angle: "comps", label: "Comps", summary: "Use comps", key_points: ["p1"] }),
  ];
  const sel = selectFromBank(rows, ctx(), {}, "seed-1");
  assert(sel);
  assert(["a", "b"].includes(sel.bankId));
  // deterministic for the same seed
  const again = selectFromBank(rows, ctx(), {}, "seed-1");
  assertEquals(again?.bankId, sel.bankId);
  // BankSelection carries grounding for the picked row
  if (sel.bankId === "b") {
    assertEquals(sel.summary, "Use comps");
    assertEquals(sel.keyPoints, ["p1"]);
  }
});

Deno.test("selectFromBank falls back to least-recently-used when all are covered", () => {
  const rows = [
    row({ id: "old", pillar: "grading", angle: "education", last_used_at: "2026-01-02T00:00:00.000Z" }),
    row({ id: "newer", pillar: "pricing", angle: "comps", last_used_at: "2026-02-01T00:00:00.000Z" }),
  ];
  // Wide window → both within window → all filtered; fallback to oldest-used third.
  const sel = selectFromBank(rows, ctx({ cutoffIso: "2026-03-01T00:00:00.000Z" }), {}, "seed");
  assert(sel);
  assertEquals(sel.bankId, "old");
});

// ── bias weighting: catalog match inherits tuning weight, others explore ───────
Deno.test("computeBankWeights inherits catalog bias and gives others an exploration baseline", () => {
  const rows = [
    row({ pillar: "grading", angle: "education" }), // catalog id "grading-basics"
    row({ pillar: "pricing", angle: "comps" }), // not in catalog
  ];
  const weights = computeBankWeights(rows, { "grading-basics": 80, "platform-tips": 20 });
  assertEquals(weights[topicKey("grading", "education")], 80);
  // baseline = avg of positives (80,20)=50
  assertEquals(weights[topicKey("pricing", "comps")], 50);
});

Deno.test("pickBankTopic returns null on empty, respects zero-weight exclusion", () => {
  assertEquals(pickBankTopic([], {}, "s"), null);
});

Deno.test("bankRowToTopic maps catalog pairs to their tuning id", () => {
  assertEquals(bankRowToTopic(row({ pillar: "grading", angle: "education" })).id, "grading-basics");
  assertEquals(bankRowToTopic(row({ pillar: "pricing", angle: "comps" })).id, topicKey("pricing", "comps"));
});

// ── AC4: refill threshold + parse ──────────────────────────────────────────────
Deno.test("needsRefill triggers strictly below the minimum", () => {
  assert(needsRefill(11, 12));
  assert(!needsRefill(12, 12));
  assert(!needsRefill(20, 12));
});

Deno.test("parseRefillCandidates slugifies and drops invalid rows", () => {
  const cands = parseRefillCandidates(
    JSON.stringify({
      candidates: [
        { pillar: "Listing", angle: "Accurate Descriptions", label: "Trust", summary: "s", key_points: ["k1", "k2"] },
        { pillar: "", angle: "x", label: "missing pillar" },
        { angle: "y", label: "missing pillar 2" },
      ],
    }),
  );
  assertEquals(cands.length, 1);
  assertEquals(cands[0].pillar, "listing");
  assertEquals(cands[0].angle, "accurate-descriptions");
});

Deno.test("normalizeRefillCandidate caps key_points to three", () => {
  const c = normalizeRefillCandidate({
    pillar: "grading",
    angle: "scale",
    label: "Scale",
    key_points: ["a", "b", "c", "d"],
  });
  assert(c);
  assertEquals(c.key_points.length, 3);
});

Deno.test("parseRefillCandidates throws on unparseable output", () => {
  let threw = false;
  try {
    parseRefillCandidates("not json");
  } catch {
    threw = true;
  }
  assert(threw);
});
