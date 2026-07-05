// US-1606 / Module K: the weekly memory-curation pass (impure orchestration over
// the pure curateMemory core). Decays every agent's memory weights, prunes rows
// that decayed below the floor or exceed the per-agent cap, and logs the pruning
// as an ops event. Wired to a weekly cron (jobs-agent-memory-curation.ts).

import { supabaseAdmin } from "./supabase.ts";
import { curateMemory, type MemoryRow } from "./agent-memory.ts";
import { emitOpsEvent } from "./ops-events.ts";

export interface MemoryCurationSummary {
  agents: number;
  decayed: number;
  pruned: number;
}

// Curate all agents' memory. Best-effort per agent — one agent's failure never
// aborts the pass. Returns aggregate counts.
export async function runMemoryCuration(): Promise<MemoryCurationSummary> {
  const { data } = await supabaseAdmin
    .from("agent_memory")
    .select("id, agent_id, kind, key, content, weight, updated_at");
  const rows = (data ?? []) as Array<MemoryRow & { agent_id: string }>;

  const byAgent = new Map<string, Array<MemoryRow & { agent_id: string }>>();
  for (const r of rows) {
    const list = byAgent.get(r.agent_id);
    if (list) list.push(r);
    else byAgent.set(r.agent_id, [r]);
  }

  let decayedTotal = 0;
  let prunedTotal = 0;
  for (const [agentId, agentRows] of byAgent) {
    const { keep, drop, decayed } = curateMemory(agentRows);
    decayedTotal += decayed;

    // Persist decayed weights for survivors that stayed (weight changed).
    const updates = keep
      .filter((r): r is MemoryRow & { id: string } => typeof r.id === "string")
      .map((r) => supabaseAdmin.from("agent_memory").update({ weight: r.weight } as never).eq("id", r.id));

    const dropIds = drop.map((r) => r.id).filter((x): x is string => typeof x === "string");
    if (dropIds.length) {
      await supabaseAdmin.from("agent_memory").delete().in("id", dropIds);
      prunedTotal += dropIds.length;
      emitOpsEvent("agent.memory.pruned", "info", {
        title: `Pruned ${dropIds.length} memory row(s) for an agent`,
        source: "agent-memory-curation",
        data: { agent_id: agentId, pruned: dropIds.length, kept: keep.length },
      });
    }
    await Promise.all(updates).catch(() => {});
  }

  return { agents: byAgent.size, decayed: decayedTotal, pruned: prunedTotal };
}
