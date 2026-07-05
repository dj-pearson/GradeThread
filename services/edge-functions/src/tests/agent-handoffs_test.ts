// US-1613: agent-to-agent handoff pure logic — intent parsing, provenance
// inheritance, and routing (deliver / unaccepted downgrade / hop-cap downgrade).
import { assert, assertEquals } from "@std/assert";
import {
  formatHandoffBlock,
  HANDOFF_HOP_CAP,
  type HandoffIntent,
  inheritedProvenance,
  parseHandoffIntents,
  type QueuedHandoff,
  routeHandoff,
  selectHandoffsForContext,
} from "../lib/agent-handoffs.ts";

const intent = (over: Partial<HandoffIntent> = {}): HandoffIntent => ({
  target_agent: "sentinel", kind: "ticket_cluster", payload: { count: 4 }, evidence: { terms: ["payout"] }, ...over,
});

// ── Parsing ──────────────────────────────────────────────────────────────────

Deno.test("parseHandoffIntents: keeps well-formed, drops junk", () => {
  const out = parseHandoffIntents([
    { target_agent: "sentinel", kind: "ticket_cluster", payload: { a: 1 }, evidence: null },
    { target_agent: "", kind: "x" }, // no target
    { target_agent: "x", kind: "" }, // no kind
    "nope",
    { target_agent: "integrations-watchdog", kind: "vendor_degradation" }, // payload/evidence default null
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0].target_agent, "sentinel");
  assertEquals(out[1].payload, null);
  assertEquals(out[1].evidence, null);
});

Deno.test("parseHandoffIntents: non-array → []", () => {
  assertEquals(parseHandoffIntents(undefined), []);
  assertEquals(parseHandoffIntents({ target_agent: "x" }), []);
});

// ── Provenance inheritance ───────────────────────────────────────────────────

Deno.test("inheritedProvenance: picks the deepest consumed chain", () => {
  const consumed: QueuedHandoff[] = [
    { target_agent: "b", origin_agent: "a", origin_run_id: "r1", kind: "k", payload: null, evidence: null, hop: 1, provenance: [{ agent: "a", run_id: "r1" }] },
    { target_agent: "b", origin_agent: "z", origin_run_id: "r9", kind: "k", payload: null, evidence: null, hop: 2, provenance: [{ agent: "y", run_id: "r8" }, { agent: "z", run_id: "r9" }] },
  ];
  assertEquals(inheritedProvenance(consumed).map((p) => p.agent), ["y", "z"]);
  assertEquals(inheritedProvenance([]), []);
});

// ── Routing ──────────────────────────────────────────────────────────────────

Deno.test("routeHandoff: accepted origin within hop cap → deliver, chain extended", () => {
  const r = routeHandoff(intent(), { agent: "support-triage", runId: "run-1", inherited: [] }, { acceptsFrom: ["support-triage"] });
  assertEquals(r.decision, "deliver");
  if (r.decision !== "deliver") return;
  assertEquals(r.handoff.hop, 1);
  assertEquals(r.handoff.provenance, [{ agent: "support-triage", run_id: "run-1" }]);
  assertEquals(r.handoff.origin_agent, "support-triage");
  assertEquals(r.handoff.target_agent, "sentinel");
});

Deno.test("routeHandoff: origin not in accepts_handoffs_from → downgrade to admin task", () => {
  const r = routeHandoff(intent(), { agent: "growth", runId: "run-1", inherited: [] }, { acceptsFrom: ["support-triage"] });
  assertEquals(r.decision, "downgrade_unaccepted");
  if (r.decision !== "downgrade_unaccepted") return;
  assert(r.task.title.includes("Unaccepted handoff"));
  assert(r.task.body.includes("growth"));
});

Deno.test("routeHandoff: a chain that would exceed the hop cap downgrades — even if accepted", () => {
  // inherited chain already at the cap length → next hop = cap + 1.
  const inherited = Array.from({ length: HANDOFF_HOP_CAP }, (_, i) => ({ agent: `a${i}`, run_id: `r${i}` }));
  const r = routeHandoff(intent(), { agent: "sentinel", runId: "run-9", inherited }, { acceptsFrom: ["sentinel"] });
  assertEquals(r.decision, "downgrade_hopcap");
  if (r.decision !== "downgrade_hopcap") return;
  assert(r.task.title.includes("chain too long"));
});

Deno.test("routeHandoff: the LAST allowed hop still delivers", () => {
  const inherited = Array.from({ length: HANDOFF_HOP_CAP - 1 }, (_, i) => ({ agent: `a${i}`, run_id: `r${i}` }));
  const r = routeHandoff(intent(), { agent: "mid", runId: "run-3", inherited }, { acceptsFrom: ["mid"] });
  assertEquals(r.decision, "deliver");
  if (r.decision !== "deliver") return;
  assertEquals(r.handoff.hop, HANDOFF_HOP_CAP);
});

// ── Context helpers ──────────────────────────────────────────────────────────

Deno.test("selectHandoffsForContext: caps how many a run consumes", () => {
  const many: QueuedHandoff[] = Array.from({ length: 25 }, (_, i) => ({
    target_agent: "b", origin_agent: "a", origin_run_id: `r${i}`, kind: "k", payload: null, evidence: null, hop: 1, provenance: [],
  }));
  assertEquals(selectHandoffsForContext(many).length, 10);
});

Deno.test("formatHandoffBlock: empty → '', non-empty is self-describing", () => {
  assertEquals(formatHandoffBlock([]), "");
  const block = formatHandoffBlock([{
    target_agent: "sentinel", origin_agent: "support-triage", origin_run_id: "r1", kind: "ticket_cluster",
    payload: { count: 4 }, evidence: null, hop: 1, provenance: [{ agent: "support-triage", run_id: "r1" }],
  }]);
  assert(block.includes("HANDOFFS"));
  assert(block.includes("support-triage"));
  assert(block.includes("ticket_cluster"));
});
