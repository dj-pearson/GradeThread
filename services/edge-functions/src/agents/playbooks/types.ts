// US-1605 / AGENTIC-OS Phase 2 (Module W): the playbook FORMAT.
//
// Playbooks are declarative, REPO-VERSIONED remediations (reviewed like code, not
// stored in the DB — the DB holds executions, not definitions). Each playbook is
// an ordered list of steps referencing REGISTERED write tools with params, an
// abort-on-failure default, and optional condition guards for branching.

export interface PlaybookGuard {
  // Run this step only if the referenced prior step's outcome matches:
  //   requires "ok"    → run only if that step SUCCEEDED
  //   requires "error" → run only if that step FAILED (e.g. escalate on failure)
  afterStep: string;
  requires: "ok" | "error";
}

export interface PlaybookStep {
  id: string; // stable id (guards reference it)
  tool: string; // a REGISTERED write tool name (retry_job / create_admin_task / …)
  params: Record<string, unknown>;
  description: string;
  guard?: PlaybookGuard;
  // Abort-on-failure is the DEFAULT (haltOnError omitted ⇒ true). Set false for a
  // best-effort step whose failure a later guard reacts to instead of halting.
  haltOnError?: boolean;
}

export interface Playbook {
  key: string;
  title: string;
  description: string;
  // The subsystem this playbook remediates — surfaced so an agent can match it.
  matches: string;
  steps: PlaybookStep[];
}
