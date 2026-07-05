// US-1605 / Module W: the playbook registry — repo-versioned remediations.
//
// Three seed playbooks codifying existing runbook procedures; each references
// ONLY existing registered write tools (retry_job with registered cron keys +
// create_admin_task). Add a playbook here to make it proposable.

import type { Playbook } from "./types.ts";

export type { Playbook } from "./types.ts";
export type { PlaybookGuard, PlaybookStep } from "./types.ts";

// Codifies the stuck-submissions runbook: fire the drain + AutoLister/publish
// reclaims; if the drain itself errors, escalate to an operator.
const STUCK_SUBMISSIONS_DRAIN: Playbook = {
  key: "stuck-submissions-drain",
  title: "Drain stuck submissions",
  description: "Re-fire the stuck-submissions drain and the pipeline reclaim jobs; escalate if the drain fails.",
  matches: "stuck-submissions",
  steps: [
    { id: "drain", tool: "retry_job", params: { job_key: "stuck-submissions" }, description: "Re-fire the stuck-submissions drain cron.", haltOnError: false },
    { id: "autolister", tool: "retry_job", params: { job_key: "autolister-reclaim" }, description: "Reclaim stalled AutoLister generation batches." },
    { id: "publish", tool: "retry_job", params: { job_key: "publish-batch-reclaim" }, description: "Reclaim stalled publish batches." },
    {
      id: "escalate",
      tool: "create_admin_task",
      params: { title: "Stuck-submissions drain failed", body: "The stuck-submissions drain cron errored during a playbook run — investigate the job.", priority: "high" },
      description: "File an admin task if the drain itself failed.",
      guard: { afterStep: "drain", requires: "error" },
    },
  ],
};

// Dead-letter requeue: re-fire the email retry cron; note the run for the operator.
const DEAD_LETTER_REQUEUE_BATCH: Playbook = {
  key: "dead-letter-requeue-batch",
  title: "Requeue email dead-letters",
  description: "Re-fire the email retry cron to drain the dead-letter backlog and record the action.",
  matches: "email:dead_letter",
  steps: [
    { id: "retry", tool: "retry_job", params: { job_key: "email-retry" }, description: "Re-fire the email retry/dead-letter drain cron." },
    {
      id: "note",
      tool: "create_admin_task",
      params: { title: "Email dead-letters requeued via playbook", body: "The email-retry cron was re-fired to drain the dead-letter backlog. Confirm the backlog cleared.", priority: "low" },
      description: "Record the requeue for operator follow-up.",
      guard: { afterStep: "retry", requires: "ok" },
    },
  ],
};

// Webhook backlog recovery: re-fire the pending-webhooks processor.
const WEBHOOK_BACKLOG_RECOVERY: Playbook = {
  key: "webhook-backlog-recovery",
  title: "Recover webhook backlog",
  description: "Re-fire the pending-webhooks processor to work down a backlog; escalate on failure.",
  matches: "webhook:backlog",
  steps: [
    { id: "process", tool: "retry_job", params: { job_key: "ebay-pending-webhooks" }, description: "Re-fire the eBay pending-webhooks processor.", haltOnError: false },
    {
      id: "escalate",
      tool: "create_admin_task",
      params: { title: "Webhook backlog recovery failed", body: "The pending-webhooks processor errored during a playbook run — check the webhook subsystem.", priority: "high" },
      description: "Escalate if the processor failed.",
      guard: { afterStep: "process", requires: "error" },
    },
  ],
};

const PLAYBOOKS: Record<string, Playbook> = {
  [STUCK_SUBMISSIONS_DRAIN.key]: STUCK_SUBMISSIONS_DRAIN,
  [DEAD_LETTER_REQUEUE_BATCH.key]: DEAD_LETTER_REQUEUE_BATCH,
  [WEBHOOK_BACKLOG_RECOVERY.key]: WEBHOOK_BACKLOG_RECOVERY,
};

export function playbookFor(key: string): Playbook | null {
  return PLAYBOOKS[key] ?? null;
}

export function allPlaybooks(): Playbook[] {
  return Object.values(PLAYBOOKS);
}
