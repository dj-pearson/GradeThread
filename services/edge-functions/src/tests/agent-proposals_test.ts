// US-1587: proposal lifecycle engine — persistence idempotency, approve-once
// execution (concurrent claim → single execute), expiry, reject. Types erased;
// runtime values dynamic-imported after env prime (agent-proposals.ts pulls in
// supabase.ts via prodProposalDeps + agent-tools).
import { assert, assertEquals } from "@std/assert";
import type { ProposalDeps, ProposalRow } from "../lib/agent-proposals.ts";
import type { ProposalDraft } from "../lib/agent-policy.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const {
  approveProposal,
  canExecute,
  expireProposals,
  isExpired,
  persistProposals,
  rejectProposal,
} = await import("../lib/agent-proposals.ts");

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

function draft(key: string | null): ProposalDraft {
  return {
    agent_id: "a1",
    action_class: "retry_job",
    title: "Retry billing-reconciliation",
    summary: null,
    payload: { job_key: "billing-reconciliation" },
    evidence: null,
    status: "pending",
    idempotency_key: key,
    policy: { level: 2, note: null, would_execute: true },
  };
}

function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: "p1",
    agent_id: "a1",
    run_id: "r1",
    action_class: "retry_job",
    title: "t",
    summary: null,
    payload: { job_key: "billing-reconciliation" },
    status: "pending",
    expires_at: null,
    idempotency_key: "k1",
    executed_at: null,
    result: null,
    ...over,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

Deno.test("isExpired / canExecute", () => {
  assertEquals(isExpired(null, NOW), false); // null never expires
  assertEquals(isExpired(new Date(NOW - 1).toISOString(), NOW), true);
  assertEquals(isExpired(new Date(NOW + HOUR).toISOString(), NOW), false);
  assertEquals(canExecute("approved", new Date(NOW + HOUR).toISOString(), NOW), true);
  assertEquals(canExecute("approved", new Date(NOW - 1).toISOString(), NOW), false); // expired
  assertEquals(canExecute("pending", null, NOW), false); // not approved
});

// ── Persistence idempotency ──────────────────────────────────────────────────

Deno.test("persistProposals: idempotency_key dedups a re-run", async () => {
  const seen = new Set<string>();
  const deps: Partial<ProposalDeps> = {
    now: () => NOW,
    insertProposals: (rows) => {
      let n = 0;
      for (const r of rows) {
        const k = r.idempotency_key as string | null;
        if (k && seen.has(k)) continue; // simulate the UNIQUE constraint
        if (k) seen.add(k);
        n++;
      }
      return Promise.resolve(n);
    },
  };
  const drafts = [draft("k1"), draft("k2")];
  assertEquals(await persistProposals("a1", "r1", drafts, 72, deps), 2);
  assertEquals(await persistProposals("a1", "r1", drafts, 72, deps), 0); // re-run → all dup
});

Deno.test("persistProposals: stamps a TTL expiry and passes rows through", async () => {
  let captured: Record<string, unknown>[] = [];
  const deps: Partial<ProposalDeps> = {
    now: () => NOW,
    insertProposals: (rows) => {
      captured = rows;
      return Promise.resolve(rows.length);
    },
  };
  await persistProposals("a1", "r1", [draft("k1")], 48, deps);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].status, "pending");
  assertEquals(captured[0].expires_at, new Date(NOW + 48 * HOUR).toISOString());
  assertEquals(captured[0].run_id, "r1");
});

// ── Approve-once execution ───────────────────────────────────────────────────

function claimHarness(initial: ProposalRow) {
  let current = { ...initial };
  let runCalls = 0;
  const events: string[] = [];
  const deps: Partial<ProposalDeps> = {
    now: () => NOW,
    loadProposal: () => Promise.resolve({ ...current }),
    claimStatus: (_id, from, to, patch) => {
      if (current.status === from) {
        current = { ...current, status: to, ...patch } as ProposalRow;
        return Promise.resolve({ ...current });
      }
      return Promise.resolve(null); // lost the atomic claim
    },
    finalizeExecution: (_id, status, result) => {
      current = { ...current, status, result } as ProposalRow;
      return Promise.resolve();
    },
    runWriteTool: () => {
      runCalls++;
      return Promise.resolve({ ok: true, status: 202 });
    },
    emitEvent: (type) => {
      events.push(type);
    },
  };
  return { deps, runCalls: () => runCalls, state: () => current, events: () => events };
}

Deno.test("approveProposal: a concurrent double-approve executes EXACTLY once", async () => {
  const h = claimHarness(row());
  const [a, b] = await Promise.all([
    approveProposal("p1", "admin", h.deps),
    approveProposal("p1", "admin", h.deps),
  ]);
  assertEquals(h.runCalls(), 1); // the write tool ran once
  const executed = [a, b].filter((r) => r.status === "executed");
  const lost = [a, b].filter((r) => r.reason === "already_decided");
  assertEquals(executed.length, 1);
  assertEquals(lost.length, 1);
  assertEquals(h.state().status, "executed");
  // US-1589: the winner emits approved then executed (the loser emits nothing).
  assertEquals(h.events(), ["agent.proposal.approved", "agent.proposal.executed"]);
});

Deno.test("approveProposal: a write-tool soft error marks the proposal failed", async () => {
  const h = claimHarness(row());
  h.deps.runWriteTool = () => Promise.resolve({ error: { code: "unknown_job" } });
  const res = await approveProposal("p1", "admin", h.deps);
  assertEquals(res.status, "failed");
  assertEquals(h.state().status, "failed");
});

Deno.test("approveProposal: an expired proposal is refused and never executes", async () => {
  const h = claimHarness(row({ expires_at: new Date(NOW - 1).toISOString() }));
  const res = await approveProposal("p1", "admin", h.deps);
  assertEquals(res.ok, false);
  assertEquals(res.reason, "expired");
  assertEquals(h.runCalls(), 0);
});

Deno.test("approveProposal: a missing proposal → not_found", async () => {
  const res = await approveProposal("ghost", "admin", {
    now: () => NOW,
    loadProposal: () => Promise.resolve(null),
  });
  assertEquals(res.reason, "not_found");
});

// ── Reject ───────────────────────────────────────────────────────────────────

Deno.test("rejectProposal: claims pending→rejected; a decided one is refused", async () => {
  const h = claimHarness(row());
  const ok = await rejectProposal("p1", "admin", "not needed", h.deps);
  assertEquals(ok, { ok: true, status: "rejected" });
  assertEquals(h.events(), ["agent.proposal.rejected"]);
  // Second reject loses the claim → not_pending.
  const again = await rejectProposal("p1", "admin", "again", h.deps);
  assertEquals(again.ok, false);
  assert((again.reason ?? "").startsWith("not_pending"));
});

// ── Expiry sweep ─────────────────────────────────────────────────────────────

Deno.test("expireProposals: returns the count expired", async () => {
  const res = await expireProposals({
    now: () => NOW,
    expirePast: (nowIso) => {
      assertEquals(nowIso, new Date(NOW).toISOString());
      return Promise.resolve(4);
    },
  });
  assertEquals(res, 4);
});
