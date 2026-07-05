// US-1603: CEO Brief pure assembly — headline metric deltas, honest attribution
// (only agents that ran), and graceful degradation (full fleet vs empty fleet).
import { assert, assertEquals } from "@std/assert";
import {
  type AgentLatestRun,
  assembleCeoBriefContext,
  ceoBriefHeadline,
  type MetricInput,
} from "../lib/ceo-brief.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");

const FLEET = [
  { key: "finance", name: "Finance" },
  { key: "sentinel", name: "Sentinel" },
  { key: "pricing", name: "Pricing" },
  { key: "trust-safety", name: "Trust & Safety" },
];

const METRICS: MetricInput[] = [
  { name: "New signups", current: 150, prior: 100 }, // +50%
  { name: "Grades issued", current: 90, prior: 100 }, // -10%
  { name: "Listings created", current: 0, prior: 0 }, // unknown delta
];

// ── Headline metric deltas ───────────────────────────────────────────────────

Deno.test("assembleCeoBriefContext: computes WoW deltas + directions, unknown when prior 0", () => {
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: [], pendingProposals: [] });
  const byName = Object.fromEntries(ctx.headline_metrics.map((m) => [m.name, m]));
  assertEquals(byName["New signups"].delta_pct, 0.5);
  assertEquals(byName["New signups"].direction, "up");
  assertEquals(byName["Grades issued"].direction, "down");
  assertEquals(byName["Listings created"].delta_pct, null);
  assertEquals(byName["Listings created"].direction, "unknown");
});

// ── Honest attribution ───────────────────────────────────────────────────────

Deno.test("assembleCeoBriefContext: only succeeded runs with a summary become observations", () => {
  const runs: AgentLatestRun[] = [
    { agent_key: "finance", status: "succeeded", summary: "1 reconciliation delta", ran_at: null },
    { agent_key: "sentinel", status: "failed", summary: "crashed", ran_at: null }, // failed → not cited
    { agent_key: "pricing", status: "succeeded", summary: "  ", ran_at: null }, // blank → not cited
  ];
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: runs, pendingProposals: [] });
  assertEquals(ctx.observations.map((o) => o.agent_key), ["finance"]);
  assertEquals(ctx.observations[0].name, "Finance"); // resolved from the fleet
  assertEquals(ctx.coverage.agents_ran, 1);
  assertEquals(ctx.attribution_allowed, true);
});

// ── Graceful degradation (full fleet vs empty fleet) ─────────────────────────

Deno.test("assembleCeoBriefContext: full fleet reporting is NOT degraded + allows attribution", () => {
  const runs: AgentLatestRun[] = FLEET.map((a) => ({ agent_key: a.key, status: "succeeded", summary: `${a.key} ok`, ran_at: null }));
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: runs, pendingProposals: [] });
  assertEquals(ctx.coverage, { agents_total: 4, agents_ran: 4 });
  assertEquals(ctx.degraded, false);
  assertEquals(ctx.attribution_allowed, true);
});

Deno.test("assembleCeoBriefContext: empty fleet → degraded, no observations, attribution forbidden", () => {
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: [], pendingProposals: [] });
  assertEquals(ctx.observations, []);
  assertEquals(ctx.degraded, true); // 0 of 4 ran
  assertEquals(ctx.attribution_allowed, false); // narrator must not fabricate a cause
  // Metrics still present so the brief has substance.
  assertEquals(ctx.headline_metrics.length, 3);
});

Deno.test("assembleCeoBriefContext: below-half coverage is degraded", () => {
  const runs: AgentLatestRun[] = [{ agent_key: "finance", status: "succeeded", summary: "ok", ran_at: null }];
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: runs, pendingProposals: [] });
  assertEquals(ctx.degraded, true); // 1 of 4 < half
  assertEquals(ctx.attribution_allowed, true); // but the one that ran is still citable
});

// ── Headline ─────────────────────────────────────────────────────────────────

Deno.test("ceoBriefHeadline: leads with the biggest mover + coverage", () => {
  const ctx = assembleCeoBriefContext({ nowMs: NOW, agents: FLEET, metrics: METRICS, latestRuns: [], pendingProposals: [] });
  const h = ceoBriefHeadline(ctx);
  assert(h.includes("New signups")); // +50% is the biggest move
  assert(h.includes("0/4 agents reported"));
});
