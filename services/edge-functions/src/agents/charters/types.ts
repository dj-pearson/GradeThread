// US-1593 / Module H: the shared agent-charter shape (repo-versioned prompts).

export interface AgentCharter {
  /** The agents.key this charter drives. */
  key: string;
  /** A stable charter version slug for attribution (bump on prompt changes). */
  version: string;
  /** The system prompt the kernel uses for this agent. */
  systemPrompt: string;
  /** Soft output-token target for a healthy no-op run (guidance, not enforced). */
  tokenFloor?: number;
}
