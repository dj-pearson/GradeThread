// US-1595: Support Triage pure logic — PII-safe excerpts, classification
// validation, deterministic cluster detection, and memo shaping.
import { assert, assertEquals } from "@std/assert";
import {
  assembleTriageMemo,
  detectClusters,
  normalizeClassification,
  prepareExcerpt,
  significantTokens,
  type TriageTicket,
} from "../lib/support-triage.ts";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const HOUR = 3600_000;

const ticket = (over: Partial<TriageTicket>): TriageTicket => ({
  id: "t", subject: "", excerpt: "", created_ms: NOW - HOUR, priority: "normal", status: "open", ...over,
});

// ── PII minimization (AC5) ───────────────────────────────────────────────────

Deno.test("prepareExcerpt: scrubs email + caps length", () => {
  const out = prepareExcerpt("Contact me at jane.doe@example.com about my   refund");
  assert(!out.includes("jane.doe@example.com"));
  assert(out.includes("[redacted:email]"));
  const long = prepareExcerpt("x".repeat(500));
  assert(long.length <= 281); // 280 + ellipsis
  assert(long.endsWith("…"));
});

// ── Classification validation ────────────────────────────────────────────────

Deno.test("normalizeClassification: enforces enums + a known KB slug", () => {
  const slugs = new Set(["payouts", "grading-101"]);
  assertEquals(
    normalizeClassification({ ticket_id: "t1", category: "billing", severity: "high", kb_slug: "payouts" }, slugs),
    { ticket_id: "t1", category: "billing", severity: "high", kb_slug: "payouts" },
  );
  // Unknown slug → nulled, not rejected.
  assertEquals(
    normalizeClassification({ ticket_id: "t2", category: "grading", severity: "low", kb_slug: "ghost" }, slugs)?.kb_slug,
    null,
  );
  // Bad category / severity / missing id → dropped.
  assertEquals(normalizeClassification({ ticket_id: "t3", category: "nope", severity: "high" }, slugs), null);
  assertEquals(normalizeClassification({ ticket_id: "t4", category: "billing", severity: "extreme" }, slugs), null);
  assertEquals(normalizeClassification({ category: "billing", severity: "high" }, slugs), null);
});

Deno.test("significantTokens: drops stopwords + short tokens", () => {
  const toks = significantTokens("The payout reconciliation is broken for me");
  assert(toks.has("payout"));
  assert(toks.has("reconciliation"));
  assert(toks.has("broken"));
  assert(!toks.has("the")); // stopword
  assert(!toks.has("for")); // stopword
  assert(!toks.has("me")); // <4 chars
});

// ── Cluster detection ────────────────────────────────────────────────────────

Deno.test("detectClusters: N similar tickets in-window form ONE cluster", () => {
  const tickets = [
    ticket({ id: "a", subject: "Payout reconciliation broken", created_ms: NOW - HOUR }),
    ticket({ id: "b", subject: "payout reconciliation shows wrong total", created_ms: NOW - 2 * HOUR }),
    ticket({ id: "c", subject: "reconciliation payout total broken", created_ms: NOW - 3 * HOUR }),
    ticket({ id: "d", subject: "cannot reset grading password", created_ms: NOW - HOUR }), // unrelated
  ];
  const clusters = detectClusters(tickets);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].size, 3);
  assertEquals([...clusters[0].ticket_ids].sort(), ["a", "b", "c"]);
  assert(clusters[0].terms.includes("payout"));
  assert(clusters[0].terms.includes("reconciliation"));
});

Deno.test("detectClusters: similar but OUT of window does not cluster", () => {
  const tickets = [
    ticket({ id: "a", subject: "payout reconciliation broken", created_ms: NOW - HOUR }),
    ticket({ id: "b", subject: "payout reconciliation broken", created_ms: NOW - 2 * HOUR }),
    // Same text but 3 days later → outside the 24h window.
    ticket({ id: "c", subject: "payout reconciliation broken", created_ms: NOW - 72 * HOUR }),
  ];
  const clusters = detectClusters(tickets);
  assertEquals(clusters.length, 0); // only 2 in-window pair < minSize 3
});

Deno.test("detectClusters: below minSize yields nothing", () => {
  const tickets = [
    ticket({ id: "a", subject: "payout reconciliation broken", created_ms: NOW }),
    ticket({ id: "b", subject: "payout reconciliation broken", created_ms: NOW - HOUR }),
  ];
  assertEquals(detectClusters(tickets).length, 0);
});

// ── Memo ─────────────────────────────────────────────────────────────────────

Deno.test("assembleTriageMemo: empty inbox is all_clear", () => {
  const memo = assembleTriageMemo([], [{ slug: "x", title: "X" }], NOW);
  assertEquals(memo.all_clear, true);
  assertEquals(memo.untriaged.length, 0);
  assertEquals(memo.clusters.length, 0);
  assert(memo.summary.includes("inbox clear"));
});

Deno.test("assembleTriageMemo: reports untriaged + age + clusters", () => {
  const tickets = [
    ticket({ id: "a", subject: "payout reconciliation broken", created_ms: NOW - 5 * HOUR }),
    ticket({ id: "b", subject: "payout reconciliation broken", created_ms: NOW - 6 * HOUR }),
    ticket({ id: "c", subject: "payout reconciliation broken", created_ms: NOW - 7 * HOUR }),
  ];
  const memo = assembleTriageMemo(tickets, [], NOW);
  assertEquals(memo.all_clear, false);
  assertEquals(memo.untriaged.length, 3);
  assertEquals(memo.untriaged[0].age_hours, 5);
  assertEquals(memo.clusters.length, 1);
  assertEquals(memo.clusters[0].size, 3);
});
