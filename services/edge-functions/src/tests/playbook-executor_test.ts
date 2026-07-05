// US-1605: playbook executor — guard evaluation, happy path, mid-run failure
// honesty, and condition-guard skip. playbook-executor.ts imports the playbook
// registry (pure) — no supabase — so no env priming needed.
import { assert, assertEquals } from "@std/assert";
import {
  evalGuard,
  type PlaybookExecDeps,
  runPlaybook,
} from "../lib/playbook-executor.ts";
import type { Playbook } from "../agents/playbooks/index.ts";
import { allPlaybooks, playbookFor } from "../agents/playbooks/index.ts";

// A deps double: executeWrite returns ok unless the tool/params say to fail.
function fakeDeps(failTools: Set<string> = new Set()): { deps: PlaybookExecDeps; steps: string[]; audits: string[] } {
  const steps: string[] = [];
  const audits: string[] = [];
  const deps: PlaybookExecDeps = {
    executeWrite: (tool, params) => {
      const id = (params as { _id?: string })?._id ?? tool;
      return Promise.resolve(failTools.has(id) ? { error: { code: "boom", message: "step failed" } } : { ok: true });
    },
    recordStep: (row) => {
      steps.push(row.name);
      return Promise.resolve();
    },
    audit: (input) => {
      audits.push(input.targetId);
      return Promise.resolve();
    },
    now: () => 1_000,
  };
  return { deps, steps, audits };
}

const ctx = { authorizedBy: "admin-1", proposalId: "p1", runId: "run-1" };

const pb = (steps: Playbook["steps"]): Playbook => ({ key: "test-pb", title: "T", description: "d", matches: "x", steps });

// ── evalGuard (pure) ─────────────────────────────────────────────────────────

Deno.test("evalGuard: no guard runs; requires-ok/error gate on the prior outcome", () => {
  assertEquals(evalGuard(undefined, new Map()), true);
  const okMap = new Map([["a", { ok: true }]]);
  assertEquals(evalGuard({ afterStep: "a", requires: "ok" }, okMap), true);
  assertEquals(evalGuard({ afterStep: "a", requires: "error" }, okMap), false);
  const errMap = new Map([["a", { ok: false }]]);
  assertEquals(evalGuard({ afterStep: "a", requires: "error" }, errMap), true);
  // referenced step never ran → skip
  assertEquals(evalGuard({ afterStep: "missing", requires: "ok" }, new Map()), false);
});

// ── Executor ─────────────────────────────────────────────────────────────────

Deno.test("runPlaybook: happy path runs every step + records each", async () => {
  const { deps, steps, audits } = fakeDeps();
  const res = await runPlaybook(
    pb([
      { id: "s1", tool: "retry_job", params: {}, description: "" },
      { id: "s2", tool: "retry_job", params: {}, description: "" },
    ]),
    ctx,
    deps,
  );
  assertEquals(res.status, "executed");
  assertEquals(res.completed, 2);
  assertEquals(res.halted_at, null);
  assertEquals(res.steps.map((s) => s.status), ["ok", "ok"]);
  assertEquals(steps.length, 2); // agent_run_steps rows
  assertEquals(audits.length, 2);
});

Deno.test("runPlaybook: mid-run failure halts + records partial completion honestly", async () => {
  const { deps } = fakeDeps(new Set(["fail"]));
  const res = await runPlaybook(
    pb([
      { id: "s1", tool: "retry_job", params: {}, description: "" },
      { id: "s2", tool: "retry_job", params: { _id: "fail" }, description: "" }, // halts (default)
      { id: "s3", tool: "retry_job", params: {}, description: "" }, // never reached
    ]),
    ctx,
    deps,
  );
  assertEquals(res.status, "failed");
  assertEquals(res.halted_at, "s2");
  assertEquals(res.completed, 1); // only s1 succeeded
  assertEquals(res.steps.map((s) => s.status), ["ok", "failed"]); // s3 not attempted
  assertEquals(res.steps[1].error, "step failed");
});

Deno.test("runPlaybook: a guarded step is SKIPPED when its guard is not met", async () => {
  const { deps } = fakeDeps();
  const res = await runPlaybook(
    pb([
      { id: "s1", tool: "retry_job", params: {}, description: "" }, // succeeds
      { id: "escalate", tool: "create_admin_task", params: {}, description: "", guard: { afterStep: "s1", requires: "error" } },
    ]),
    ctx,
    deps,
  );
  assertEquals(res.status, "executed");
  assertEquals(res.steps.map((s) => s.status), ["ok", "skipped"]);
  assertEquals(res.completed, 1);
});

Deno.test("runPlaybook: haltOnError:false lets a later error-guard escalate", async () => {
  const { deps } = fakeDeps(new Set(["fail"]));
  const res = await runPlaybook(
    pb([
      { id: "drain", tool: "retry_job", params: { _id: "fail" }, description: "", haltOnError: false }, // fails but continues
      { id: "escalate", tool: "create_admin_task", params: {}, description: "", guard: { afterStep: "drain", requires: "error" } },
    ]),
    ctx,
    deps,
  );
  // Ran to completion (no halt) → executed, even though drain failed; escalate ran.
  assertEquals(res.status, "executed");
  assertEquals(res.steps.map((s) => s.status), ["failed", "ok"]);
  assertEquals(res.halted_at, null);
});

// ── Seed playbooks ───────────────────────────────────────────────────────────

Deno.test("seed playbooks: three exist, reference only known write tools, unique step ids", () => {
  const books = allPlaybooks();
  assertEquals(books.length, 3);
  const knownTools = new Set(["retry_job", "create_admin_task", "requeue_dead_letter", "reorder_review_queue"]);
  for (const b of books) {
    assert(playbookFor(b.key) === b);
    const ids = new Set<string>();
    for (const s of b.steps) {
      assert(knownTools.has(s.tool), `${b.key}:${s.id} uses unknown tool ${s.tool}`);
      assert(!ids.has(s.id), `${b.key} has a duplicate step id ${s.id}`);
      ids.add(s.id);
      if (s.guard) assert(ids.has(s.guard.afterStep) || b.steps.some((x) => x.id === s.guard!.afterStep), "guard references a real step");
    }
  }
});
