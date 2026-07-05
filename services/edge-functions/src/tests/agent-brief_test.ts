// US-1592: operator-brief assembly — busy day / quiet day / empty fleet.
// agent-brief.ts is pure (imports only email-render types), so no env/DB dance.
import { assert, assertEquals } from "@std/assert";
import {
  assembleBrief,
  type BriefInput,
  briefSubject,
  briefToEmailDocument,
  relFromNow,
} from "../lib/agent-brief.ts";

const NOW = Date.parse("2026-07-05T13:00:00.000Z");
const MC = "https://gradethread.com/admin/agents";

function base(over: Partial<BriefInput> = {}): BriefInput {
  return {
    now: NOW,
    missionControlUrl: MC,
    agents: [{ key: "sentinel", name: "Sentinel" }, { key: "finance", name: "Finance" }],
    runs24h: [],
    pendingProposals: [],
    warningEvents24h: [],
    ...over,
  };
}

Deno.test("relFromNow: future/expired/units", () => {
  assertEquals(relFromNow(new Date(NOW + 30 * 60_000).toISOString(), NOW), "in 30m");
  assertEquals(relFromNow(new Date(NOW + 3 * 3_600_000).toISOString(), NOW), "in 3h");
  assertEquals(relFromNow(new Date(NOW - 1).toISOString(), NOW), "expired");
  assertEquals(relFromNow(null, NOW), null);
});

// ── Quiet day ────────────────────────────────────────────────────────────────

Deno.test("assembleBrief: a quiet day says so in one line", () => {
  const m = assembleBrief(base({
    runs24h: [
      { agent_key: "sentinel", status: "succeeded", cost_usd: 0.12 },
      { agent_key: "finance", status: "succeeded", cost_usd: 0.08 },
    ],
  }));
  assertEquals(m.allQuiet, true);
  assertEquals(m.fleetEmpty, false);
  assertEquals(m.totalRuns, 2);
  assertEquals(m.totalSpendUsd, 0.2);
  assertEquals(m.headline, "All quiet: 2 runs, $0.20, nothing pending.");
  assertEquals(m.pending.length, 0);
  assertEquals(m.anomalies.length, 0);
});

// ── Busy day ─────────────────────────────────────────────────────────────────

Deno.test("assembleBrief: a busy day surfaces pending + anomalies + per-agent", () => {
  const m = assembleBrief(base({
    runs24h: [
      { agent_key: "sentinel", status: "succeeded", cost_usd: 0.5 },
      { agent_key: "sentinel", status: "failed", cost_usd: 0.1 },
      { agent_key: "finance", status: "succeeded", cost_usd: 0.4 },
    ],
    pendingProposals: [
      { id: "p1", agent_key: "sentinel", title: "Retry billing job", expires_at: new Date(NOW + 5 * 3_600_000).toISOString() },
    ],
    warningEvents24h: [{ type: "agent.policy_breach", title: "finance demoted L2→L1" }],
  }));
  assertEquals(m.allQuiet, false);
  assertEquals(m.totalRuns, 3);
  assertEquals(m.totalSpendUsd, 1);
  assertEquals(m.runsByOutcome.succeeded, 2);
  assertEquals(m.runsByOutcome.failed, 1);
  assertEquals(m.pending.length, 1);
  assertEquals(m.pending[0].expiresIn, "in 5h");
  assertEquals(m.pending[0].link, `${MC}#proposals`);
  assertEquals(m.anomalies.length, 1);
  // Per-agent: sentinel has 2 runs (1 failed), finance 1.
  const sentinel = m.perAgent.find((a) => a.key === "sentinel");
  assertEquals(sentinel?.runs, 2);
  assertEquals(sentinel?.failures, 1);
  assert(m.headline.includes("1 pending"));
  assert(m.headline.includes("1 anomaly"));
});

// ── Empty fleet ──────────────────────────────────────────────────────────────

Deno.test("assembleBrief: empty fleet still produces a brief", () => {
  const m = assembleBrief(base({ agents: [] }));
  assertEquals(m.fleetEmpty, true);
  assertEquals(m.headline, "Fleet is empty — no agents registered.");
  assertEquals(m.perAgent.length, 0);
});

// ── Rendering ────────────────────────────────────────────────────────────────

Deno.test("briefToEmailDocument + briefSubject: shape by day type", () => {
  const quiet = assembleBrief(base({ runs24h: [{ agent_key: "sentinel", status: "succeeded", cost_usd: 0.1 }] }));
  const qDoc = briefToEmailDocument(quiet, "2026-07-05");
  assert(qDoc.blocks.length >= 1);
  assertEquals(briefSubject(quiet, "2026-07-05"), "Operator brief 2026-07-05 — all quiet");

  const empty = assembleBrief(base({ agents: [] }));
  assertEquals(briefSubject(empty, "2026-07-05"), "Operator brief 2026-07-05 — fleet empty");

  const busy = assembleBrief(base({
    pendingProposals: [{ id: "p1", agent_key: "sentinel", title: "Do X", expires_at: null }],
    warningEvents24h: [{ type: "agent.run.failed", title: "x" }],
  }));
  const bDoc = briefToEmailDocument(busy, "2026-07-05");
  // Busy doc includes a pending section + a CTA + an anomalies section.
  assert(bDoc.blocks.some((b) => b.kind === "cta"));
  assert(briefSubject(busy, "2026-07-05").includes("pending"));
});
