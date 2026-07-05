// US-1605 / Module W: the playbook EXECUTOR — runs an approved run_playbook
// proposal step-by-step. Each step: guard check → executeWrite the step's tool →
// an audit-log entry + an agent_run_steps row. Abort-on-failure is the default;
// a failed halting step stops execution and records partial completion HONESTLY.
// The orchestration is deps-injected (executeWrite / recordStep / audit) so the
// guard logic + halt semantics are unit-tested without the registry or a DB.

import type { Playbook, PlaybookGuard } from "../agents/playbooks/index.ts";

// A step result is a tool error when it carries an { error } object (the write-
// tool convention; mirrors isToolError in agent-proposals.ts).
export function isStepError(result: unknown): boolean {
  return !!result && typeof result === "object" && !Array.isArray(result) &&
    "error" in (result as Record<string, unknown>);
}

// Does this step run, given the outcomes so far? A guard references a prior
// step id and requires it to have SUCCEEDED ("ok") or FAILED ("error"). A guard
// whose referenced step never ran ⇒ this step is skipped. Pure.
export function evalGuard(guard: PlaybookGuard | undefined, results: Map<string, { ok: boolean }>): boolean {
  if (!guard) return true;
  const prev = results.get(guard.afterStep);
  if (!prev) return false;
  return guard.requires === "ok" ? prev.ok : !prev.ok;
}

export interface PlaybookRunContext {
  authorizedBy: string;
  proposalId: string | null;
  runId: string | null;
}

export interface PlaybookExecDeps {
  executeWrite: (tool: string, params: unknown, ctx: { authorizedBy: string; proposalId: string | null }) => Promise<unknown>;
  recordStep: (row: { runId: string; seq: number; name: string; input: unknown; output: unknown; durationMs: number }) => Promise<void>;
  audit: (input: { action: string; targetType: string; targetId: string; details: Record<string, unknown> }) => Promise<void>;
  now: () => number;
}

export type PlaybookStepStatus = "ok" | "failed" | "skipped";

export interface PlaybookStepReport {
  id: string;
  tool: string;
  status: PlaybookStepStatus;
  error?: string | null;
}

export interface PlaybookRunResult {
  playbook: string;
  status: "executed" | "failed";
  steps: PlaybookStepReport[];
  completed: number; // steps that ran and succeeded
  halted_at: string | null; // the step id that halted the run (abort-on-failure)
}

function errorText(result: unknown): string | null {
  if (isStepError(result)) {
    const e = (result as { error: unknown }).error;
    if (e && typeof e === "object" && "message" in (e as Record<string, unknown>)) {
      return String((e as { message: unknown }).message);
    }
    return typeof e === "string" ? e : "error";
  }
  return null;
}

// Run the playbook. Guarded steps that don't match are SKIPPED; an executed step
// that fails halts the run UNLESS haltOnError is explicitly false (best-effort —
// a later guard reacts to it). Records every executed step; returns the honest
// partial report.
export async function runPlaybook(
  playbook: Playbook,
  ctx: PlaybookRunContext,
  deps: PlaybookExecDeps,
): Promise<PlaybookRunResult> {
  const results = new Map<string, { ok: boolean }>();
  const reports: PlaybookStepReport[] = [];
  const writeCtx = { authorizedBy: ctx.authorizedBy, proposalId: ctx.proposalId };
  let seq = 0;
  let haltedAt: string | null = null;

  for (const step of playbook.steps) {
    if (!evalGuard(step.guard, results)) {
      reports.push({ id: step.id, tool: step.tool, status: "skipped" });
      continue;
    }
    const started = deps.now();
    const result = await deps.executeWrite(step.tool, step.params, writeCtx);
    const ok = !isStepError(result);
    results.set(step.id, { ok });

    if (ctx.runId) {
      await deps.recordStep({
        runId: ctx.runId,
        seq: seq++,
        name: `playbook:${playbook.key}:${step.id}`,
        input: { tool: step.tool, params: step.params },
        output: result,
        durationMs: deps.now() - started,
      }).catch(() => {});
    }
    await deps.audit({
      action: "agent.playbook.step",
      targetType: "playbook_step",
      targetId: `${playbook.key}:${step.id}`,
      details: { playbook: playbook.key, step: step.id, tool: step.tool, ok, proposal_id: ctx.proposalId },
    }).catch(() => {});

    reports.push({ id: step.id, tool: step.tool, status: ok ? "ok" : "failed", error: ok ? null : errorText(result) });

    if (!ok && step.haltOnError !== false) {
      haltedAt = step.id;
      break;
    }
  }

  return {
    playbook: playbook.key,
    status: haltedAt ? "failed" : "executed",
    steps: reports,
    completed: reports.filter((r) => r.status === "ok").length,
    halted_at: haltedAt,
  };
}
