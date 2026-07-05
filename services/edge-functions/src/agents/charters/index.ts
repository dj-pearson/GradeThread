// US-1593 / Module H: the agent-charter registry.
//
// Maps an agents.key → its repo-versioned charter. The kernel resolves an
// agent's system prompt from here first (before agents.config.system_prompt),
// so prompt changes travel through git review, not a live DB edit. New domain
// agents (US-1594..1604) register their charter here.

import type { AgentCharter } from "./types.ts";
import { SENTINEL_CHARTER } from "./sentinel.ts";

export type { AgentCharter };

const CHARTERS: Record<string, AgentCharter> = {
  [SENTINEL_CHARTER.key]: SENTINEL_CHARTER,
};

export function charterFor(agentKey: string): AgentCharter | null {
  return CHARTERS[agentKey] ?? null;
}
