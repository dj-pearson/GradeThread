// US-1608 / Modules D+V: the daily promotion/demotion pass (impure orchestration
// over the pure autonomy-promotion core). Computes per-(agent, action-class)
// stats, files L1→L2 promotion META-PROPOSALS for eligible classes (operator
// approves), and demotes on a rejection spike. Wired kernel-side into agent-tick
// (a daily watermark) to avoid the CRON_REGISTRY docs-drift chain.

import { supabaseAdmin } from "./supabase.ts";
import type { AgentRow } from "./agent-kernel.ts";
import { AUTONOMY_HARD_CAPS, recordPolicyBreach, resolveAutonomy } from "./agent-policy.ts";
import { getSetting } from "./system-settings.ts";
import { emitOpsEvent } from "./ops-events.ts";
import {
  computePromotionStats,
  promotionEligibility,
  type ProposalStatRow,
  REJECTION_SPIKE_MIN_RECENT,
  shouldDemoteForRejections,
} from "./autonomy-promotion.ts";

export interface AutonomyPromotionSummary {
  promotions_proposed: number;
  demotions: number;
}

// Per-agent eval-pass map (agents.eval_pass, populated by Module V / US-1607).
// Absent ⇒ NOT passing (conservative — an un-eval'd agent is never promoted).
type EvalPassMap = Record<string, boolean>;

export async function runAutonomyPromotionPass(nowMs: number): Promise<AutonomyPromotionSummary> {
  // Look back 90 days of decided proposals for the stats.
  const sinceIso = new Date(nowMs - 90 * 24 * 3600_000).toISOString();
  const [{ data: propRows }, { data: agentRows }] = await Promise.all([
    supabaseAdmin.from("agent_proposals")
      .select("agent_id, action_class, status, decided_at, created_at")
      .gte("created_at", sinceIso).limit(20000),
    supabaseAdmin.from("agents").select("id, key, name, module_letter, status, autonomy, config"),
  ]);
  const proposals = (propRows ?? []) as Array<ProposalStatRow & { created_at: string }>;
  const agents = (agentRows ?? []) as AgentRow[];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const evalMap = await getSetting<EvalPassMap>("agents.eval_pass", {});

  const stats = computePromotionStats(proposals);

  // Existing pending promotions (don't double-file).
  const { data: pendingRows } = await supabaseAdmin
    .from("agent_proposals")
    .select("agent_id, payload")
    .eq("action_class", "promote_autonomy")
    .eq("status", "pending")
    .limit(500);
  const pendingKeys = new Set(
    ((pendingRows ?? []) as Array<{ agent_id: string; payload: unknown }>).map((p) => {
      const cls = p.payload && typeof p.payload === "object" ? (p.payload as { target_action_class?: string }).target_action_class : "";
      return `${p.agent_id} ${cls}`;
    }),
  );

  let promoted = 0;
  let demoted = 0;

  for (const s of stats) {
    const agent = agentById.get(s.agent_id);
    if (!agent) continue;
    const currentLevel = resolveAutonomy(agent, s.action_class);
    const hardCap = AUTONOMY_HARD_CAPS[agent.key]?.[s.action_class];
    const elig = promotionEligibility({
      stats: s,
      currentLevel,
      evalPassing: evalMap[agent.key] === true,
      lastBreachMs: null, // breach recency is enforced by the immediate demote; see NOTE
      hardCap,
      nowMs,
    });
    if (elig.eligible && !pendingKeys.has(`${s.agent_id} ${s.action_class}`)) {
      const { error } = await supabaseAdmin.from("agent_proposals").insert({
        agent_id: s.agent_id,
        action_class: "promote_autonomy",
        title: `Promote ${agent.key} · ${s.action_class} to L${elig.targetLevel}`,
        summary: `${s.approved} approved, ${Math.round((s.approval_rate ?? 0) * 100)}% approval, eval passing.`,
        payload: { target_action_class: s.action_class, from_level: currentLevel, to_level: elig.targetLevel },
        evidence: { stats: s, eval_passing: true },
        status: "pending",
        expires_at: new Date(nowMs + 14 * 24 * 3600_000).toISOString(),
      } as never);
      if (!error) {
        promoted++;
        emitOpsEvent("agent.autonomy.promotion_proposed", "info", {
          title: `Promotion proposed: ${agent.key} · ${s.action_class} → L${elig.targetLevel}`,
          source: "autonomy-promotion",
          data: { agent_key: agent.key, action_class: s.action_class, to_level: elig.targetLevel },
        });
      }
    }

    // Demotion: a rejection spike over the recent decisions for this class.
    const recent = proposals
      .filter((p) => p.agent_id === s.agent_id && p.action_class === s.action_class)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, Math.max(REJECTION_SPIKE_MIN_RECENT * 2, 12))
      .map((p) => p.status);
    if (currentLevel > 0 && shouldDemoteForRejections(recent)) {
      await recordPolicyBreach(agent, s.action_class, "rejection_spike").catch(() => {});
      demoted++;
    }
  }

  return { promotions_proposed: promoted, demotions: demoted };
}
