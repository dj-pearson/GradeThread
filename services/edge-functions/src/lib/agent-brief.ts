// US-1592 / AGENTIC-OS Phase 0 (Module N): the Daily Operator Brief.
//
// One cross-agent digest instead of N alert streams: what the fleet found, what
// is pending approval (deep-linked), spend, anomalies, and an honest "nothing
// needs you" when true (AGENTIC_OS.md §3.N). The assembly + rendering are PURE
// (fixture-tested); routes/jobs-operator-brief.ts gathers the rows, renders via
// the existing email machinery, emails admins, and persists the latest brief.

import type { EmailBlock, EmailDocument } from "./email-render.ts";

export interface BriefRun {
  agent_key: string | null;
  status: string;
  cost_usd: number;
}
export interface BriefProposal {
  id: string;
  agent_key: string | null;
  title: string;
  expires_at: string | null;
}
export interface BriefEvent {
  type: string;
  title: string | null;
}

export interface BriefInput {
  now: number;
  missionControlUrl: string;
  agents: Array<{ key: string; name: string }>;
  runs24h: BriefRun[];
  pendingProposals: BriefProposal[];
  warningEvents24h: BriefEvent[];
}

export interface BriefPerAgent {
  key: string;
  runs: number;
  spendUsd: number;
  failures: number;
}
export interface BriefPending {
  id: string;
  agentKey: string;
  title: string;
  expiresIn: string | null;
  link: string;
}
export interface BriefModel {
  headline: string;
  allQuiet: boolean;
  fleetEmpty: boolean;
  totalRuns: number;
  runsByOutcome: Record<string, number>;
  totalSpendUsd: number;
  perAgent: BriefPerAgent[];
  pending: BriefPending[];
  anomalies: Array<{ type: string; title: string }>;
  missionControlUrl: string;
}

const FAILURE_STATUSES = new Set(["failed", "timeout"]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Relative time from now, future-facing (for a proposal expiry). Pure.
export function relFromNow(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = t - nowMs;
  if (ms <= 0) return "expired";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

// Assemble the brief model from a day's rows (pure). Degrades to an "empty
// fleet" brief with zero agents, and to an "all quiet" brief when nothing is
// pending and no anomalies fired.
export function assembleBrief(input: BriefInput): BriefModel {
  const fleetEmpty = input.agents.length === 0;

  const runsByOutcome: Record<string, number> = {};
  let totalSpendUsd = 0;
  const byAgent = new Map<string, { runs: number; spendUsd: number; failures: number }>();
  for (const a of input.agents) byAgent.set(a.key, { runs: 0, spendUsd: 0, failures: 0 });

  for (const r of input.runs24h) {
    runsByOutcome[r.status] = (runsByOutcome[r.status] ?? 0) + 1;
    const cost = typeof r.cost_usd === "number" ? r.cost_usd : Number(r.cost_usd) || 0;
    totalSpendUsd += cost;
    const key = r.agent_key ?? "(unknown)";
    const slot = byAgent.get(key) ?? { runs: 0, spendUsd: 0, failures: 0 };
    slot.runs += 1;
    slot.spendUsd += cost;
    if (FAILURE_STATUSES.has(r.status)) slot.failures += 1;
    byAgent.set(key, slot);
  }

  const perAgent: BriefPerAgent[] = [...byAgent.entries()]
    .map(([key, v]) => ({ key, runs: v.runs, spendUsd: round2(v.spendUsd), failures: v.failures }))
    .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));

  const pending: BriefPending[] = input.pendingProposals.map((p) => ({
    id: p.id,
    agentKey: p.agent_key ?? "(unknown)",
    title: p.title,
    expiresIn: relFromNow(p.expires_at, input.now),
    link: `${input.missionControlUrl}#proposals`,
  }));

  const anomalies = input.warningEvents24h.map((e) => ({ type: e.type, title: e.title ?? e.type }));

  const totalRuns = input.runs24h.length;
  const spendStr = `$${round2(totalSpendUsd).toFixed(2)}`;
  const allQuiet = pending.length === 0 && anomalies.length === 0;

  let headline: string;
  if (fleetEmpty) {
    headline = "Fleet is empty — no agents registered.";
  } else if (allQuiet) {
    headline = `All quiet: ${totalRuns} run${totalRuns === 1 ? "" : "s"}, ${spendStr}, nothing pending.`;
  } else {
    headline = `${totalRuns} run${totalRuns === 1 ? "" : "s"}, ${spendStr} · ` +
      `${pending.length} pending, ${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}.`;
  }

  return {
    headline,
    allQuiet,
    fleetEmpty,
    totalRuns,
    runsByOutcome,
    totalSpendUsd: round2(totalSpendUsd),
    perAgent,
    pending,
    anomalies,
    missionControlUrl: input.missionControlUrl,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Subject line — dated, and flags when something needs the operator.
export function briefSubject(model: BriefModel, dateLabel: string): string {
  if (model.fleetEmpty) return `Operator brief ${dateLabel} — fleet empty`;
  if (model.allQuiet) return `Operator brief ${dateLabel} — all quiet`;
  return `Operator brief ${dateLabel} — ${model.pending.length} pending, ${model.anomalies.length} anomalies`;
}

// Build the send-ready EmailDocument from the model (pure). renderEmailDocument
// turns this into html + text.
export function briefToEmailDocument(model: BriefModel, dateLabel: string): EmailDocument {
  const blocks: EmailBlock[] = [
    { kind: "text", heading: `Daily Operator Brief — ${dateLabel}`, bodyHtml: `<p>${esc(model.headline)}</p>` },
  ];

  if (model.fleetEmpty) {
    return { subject: briefSubject(model, dateLabel), preheader: model.headline, blocks };
  }

  if (model.pending.length > 0) {
    const items = model.pending
      .map((p) =>
        `<li><a href="${p.link}">${esc(p.title)}</a> — ${esc(p.agentKey)}` +
        `${p.expiresIn ? ` · expires ${esc(p.expiresIn)}` : ""}</li>`
      )
      .join("");
    blocks.push({
      kind: "text",
      heading: `Pending your approval (${model.pending.length})`,
      bodyHtml: `<ul>${items}</ul>`,
    });
    blocks.push({ kind: "cta", label: "Open the proposals inbox", url: `${model.missionControlUrl}#proposals` });
  }

  if (model.anomalies.length > 0) {
    const items = model.anomalies.map((a) => `<li>${esc(a.title)}</li>`).join("");
    blocks.push({ kind: "text", heading: `Anomalies (${model.anomalies.length})`, bodyHtml: `<ul>${items}</ul>` });
  }

  const outcomes = Object.entries(model.runsByOutcome)
    .map(([k, v]) => `${esc(k)}: ${v}`)
    .join(" · ");
  const agentLines = model.perAgent
    .filter((a) => a.runs > 0)
    .map((a) =>
      `<li>${esc(a.key)}: ${a.runs} run${a.runs === 1 ? "" : "s"}, $${a.spendUsd.toFixed(2)}` +
      `${a.failures > 0 ? `, ${a.failures} failed` : ""}</li>`
    )
    .join("");
  blocks.push({ kind: "divider" });
  blocks.push({
    kind: "text",
    heading: "Activity & spend (24h)",
    bodyHtml: `<p>${model.totalRuns} runs · $${model.totalSpendUsd.toFixed(2)}${outcomes ? ` · ${outcomes}` : ""}</p>` +
      (agentLines ? `<ul>${agentLines}</ul>` : "<p>No agent activity.</p>"),
  });

  return { subject: briefSubject(model, dateLabel), preheader: model.headline, blocks };
}
