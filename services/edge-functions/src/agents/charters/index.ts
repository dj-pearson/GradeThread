// US-1593 / Module H: the agent-charter registry.
//
// Maps an agents.key → its repo-versioned charter. The kernel resolves an
// agent's system prompt from here first (before agents.config.system_prompt),
// so prompt changes travel through git review, not a live DB edit. New domain
// agents (US-1594..1604) register their charter here.

import type { AgentCharter } from "./types.ts";
import { SENTINEL_CHARTER } from "./sentinel.ts";
import { GRADING_QUALITY_CHARTER } from "./grading-quality.ts";
import { INTEGRATIONS_WATCHDOG_CHARTER } from "./integrations-watchdog.ts";
import { FINANCE_AGENT_CHARTER } from "./finance-agent.ts";
import { PRICING_AGENT_CHARTER } from "./pricing-agent.ts";
import { MARKETPLACE_OPS_CHARTER } from "./marketplace-ops-agent.ts";
import { TRUST_SAFETY_CHARTER } from "./trust-safety-agent.ts";
import { CEO_BRIEF_CHARTER } from "./ceo-brief-agent.ts";
import { GROWTH_AGENT_CHARTER } from "./growth-agent.ts";
import { CRON_GOVERNANCE_CHARTER } from "./cron-governance-agent.ts";
import { RELEASE_AGENT_CHARTER } from "./release-agent.ts";
import { EXPERIMENTS_GOVERNOR_CHARTER } from "./experiments-governor-agent.ts";
import { SUPPORT_TRIAGE_CHARTER } from "./support-triage-agent.ts";
import { MARKETING_PORTFOLIO_CHARTER } from "./marketing-portfolio-agent.ts";
import { USER_LIFECYCLE_CHARTER } from "./user-lifecycle-agent.ts";

export type { AgentCharter };

const CHARTERS: Record<string, AgentCharter> = {
  [SENTINEL_CHARTER.key]: SENTINEL_CHARTER,
  [GRADING_QUALITY_CHARTER.key]: GRADING_QUALITY_CHARTER,
  [INTEGRATIONS_WATCHDOG_CHARTER.key]: INTEGRATIONS_WATCHDOG_CHARTER,
  [FINANCE_AGENT_CHARTER.key]: FINANCE_AGENT_CHARTER,
  [PRICING_AGENT_CHARTER.key]: PRICING_AGENT_CHARTER,
  [MARKETPLACE_OPS_CHARTER.key]: MARKETPLACE_OPS_CHARTER,
  [TRUST_SAFETY_CHARTER.key]: TRUST_SAFETY_CHARTER,
  [CEO_BRIEF_CHARTER.key]: CEO_BRIEF_CHARTER,
  [GROWTH_AGENT_CHARTER.key]: GROWTH_AGENT_CHARTER,
  [CRON_GOVERNANCE_CHARTER.key]: CRON_GOVERNANCE_CHARTER,
  [RELEASE_AGENT_CHARTER.key]: RELEASE_AGENT_CHARTER,
  [EXPERIMENTS_GOVERNOR_CHARTER.key]: EXPERIMENTS_GOVERNOR_CHARTER,
  [SUPPORT_TRIAGE_CHARTER.key]: SUPPORT_TRIAGE_CHARTER,
  [MARKETING_PORTFOLIO_CHARTER.key]: MARKETING_PORTFOLIO_CHARTER,
  [USER_LIFECYCLE_CHARTER.key]: USER_LIFECYCLE_CHARTER,
};

export function charterFor(agentKey: string): AgentCharter | null {
  return CHARTERS[agentKey] ?? null;
}
