// US-1587: the proposal lifecycle — approve-once under concurrency, expiry
// (sweep + claim-time refusal), reject-with-reason, write-tool context
// refusal, and run filing with the batched notification.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import type { ProposalDb } from "../lib/agent-proposals.ts";
const {
  DEFAULT_PROPOSAL_TTL_HOURS,
  executeProposal,
  expireStaleProposals,
  fileProposalsFromRun,
  rejectProposal,
  WRITE_TOOLS,
} = await import("../lib/agent-proposals.ts");

// ── Fake proposal db with REAL conditional-claim semantics ───────────────────

interface Row {
  id: string;
  status: string;
  action_class: string;
  payload: Record<string, unknown>;
  expires_at: string | null;
  agents: { key: string };
  result?: unknown;
  decide_reason?: string;
}

function fakeDb(rows: Row[]): ProposalDb {
  return {
    claimForExecution(id, _adminId, _nowIso) {
      const row = rows.find((r) => r.id === id);
      // The conditional update: only a PENDING row claims.
      if (!row || row.status !== "pending") return Promise.resolve(null);
      row.status = "approved";
      return Promise.resolve({ ...row });
    },
    markExecuted(id, status, result) {
      const row = rows.find((r) => r.id === id)!;
      row.status = status;
      row.result = result;
      return Promise.resolve();
    },
    rejectPending(id, _adminId, reason) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== "pending") return Promise.resolve(false);
      row.status = "rejected";
      row.decide_reason = reason;
      return Promise.resolve(true);
    },
    expirePending(nowIso) {
      let n = 0;
      for (const row of rows) {
        if (row.status === "pending" && row.expires_at && row.expires_at < nowIso) {
          row.status = "expired";
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
}

function pendingRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    status: "pending",
    action_class: "requeue_dead_letter",
    payload: { tool: "requeue_dead_letter", args: { id: "dl-1" } },
    expires_at: "2099-01-01T00:00:00Z",
    agents: { key: "sentinel" },
    ...overrides,
  };
}

// Chainable fake for the write tools' db access.
// deno-lint-ignore no-explicit-any
function fakeWriteDb(result: any) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    from: () => chain,
    update: () => chain,
    insert: () => chain,
    eq: () => chain,
    in: () => chain,
    select: () => chain,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
  };
  return chain;
}

// ── Approve-once ─────────────────────────────────────────────────────────────

Deno.test("approval executes exactly once — a concurrent double-approve loses cleanly", async () => {
  const rows = [pendingRow()];
  const db = fakeDb(rows);
  const writeDb = fakeWriteDb({ data: { id: "dl-1" }, error: null });

  const [first, second] = await Promise.all([
    executeProposal("p1", "admin-1", db, writeDb),
    executeProposal("p1", "admin-2", db, writeDb),
  ]);
  const kinds = [first.kind, second.kind].sort();
  assertEquals(kinds, ["already_decided", "executed"]);
  assertEquals(rows[0].status, "executed");
});

Deno.test("a rejected proposal can never execute", async () => {
  const rows = [pendingRow()];
  const db = fakeDb(rows);
  assert(await rejectProposal("p1", "admin-1", "not worth the risk", db));
  assertEquals(rows[0].status, "rejected");

  const outcome = await executeProposal("p1", "admin-1", db, fakeWriteDb({}));
  assertEquals(outcome.kind, "already_decided");
  assertEquals(rows[0].status, "rejected"); // untouched
});

// ── Expiry ───────────────────────────────────────────────────────────────────

Deno.test("the sweep expires past-TTL pending proposals only", async () => {
  const rows = [
    pendingRow({ id: "old", expires_at: "2020-01-01T00:00:00Z" }),
    pendingRow({ id: "fresh", expires_at: "2099-01-01T00:00:00Z" }),
    pendingRow({ id: "done", status: "executed", expires_at: "2020-01-01T00:00:00Z" }),
  ];
  const swept = await expireStaleProposals(fakeDb(rows));
  assertEquals(swept, 1);
  assertEquals(rows.find((r) => r.id === "old")!.status, "expired");
  assertEquals(rows.find((r) => r.id === "fresh")!.status, "pending");
  assertEquals(rows.find((r) => r.id === "done")!.status, "executed");
});

Deno.test("an expired-but-unswept proposal is refused at claim time", async () => {
  const rows = [pendingRow({ expires_at: "2020-01-01T00:00:00Z" })];
  const outcome = await executeProposal("p1", "admin-1", fakeDb(rows), fakeWriteDb({}));
  assertEquals(outcome.kind, "expired");
  assertEquals(rows[0].status, "expired");
});

// ── Execution outcomes ───────────────────────────────────────────────────────

Deno.test("a failing write tool records failed with the redacted error", async () => {
  const rows = [pendingRow()];
  const outcome = await executeProposal(
    "p1",
    "admin-1",
    fakeDb(rows),
    fakeWriteDb({ data: null, error: null }), // requeue finds nothing
  );
  assertEquals(outcome.kind, "failed");
  assertEquals(rows[0].status, "failed");
  assert(String((rows[0].result as { error: string }).error).includes("dl-1"));
});

Deno.test("an unknown payload tool fails without throwing", async () => {
  const rows = [pendingRow({ payload: { tool: "rm_rf_prod", args: {} } })];
  const outcome = await executeProposal("p1", "a", fakeDb(rows), fakeWriteDb({}));
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed" && outcome.error.includes("unknown write tool"));
});

// ── Write-tool context refusal ───────────────────────────────────────────────

Deno.test("write tools refuse to run without an approved-proposal context", async () => {
  for (const tool of Object.values(WRITE_TOOLS)) {
    let threw = false;
    try {
      await tool.run(
        {},
        undefined as unknown as { proposalId: string; agentKey: string },
        fakeWriteDb({}),
      );
    } catch (err) {
      threw = true;
      assert(String(err).includes("approved-proposal"));
    }
    assert(threw, `${tool.name} ran without a context`);
  }
});

Deno.test("retry_job validates the slug before touching the network", async () => {
  let threw = false;
  try {
    await WRITE_TOOLS.retry_job.run(
      { job: "../secrets" },
      { proposalId: "p1", agentKey: "sentinel" },
      fakeWriteDb({}),
    );
  } catch (err) {
    threw = true;
    assert(String(err).includes("invalid job slug"));
  }
  assert(threw);
});

// ── Filing from a run ────────────────────────────────────────────────────────

Deno.test("filing validates entries, applies TTL, and batches ONE notification", async () => {
  const dispatched: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const now = new Date("2026-07-04T00:00:00Z");

  const tally = await fileProposalsFromRun(
    { id: "a1", key: "sentinel", status: "enabled", autonomy: { retry_job: 1 } },
    "run-1",
    [
      { action_class: "retry_job", title: "Retry A", summary: "s", payload: {} },
      { action_class: "retry_job", title: "Retry B", summary: "s", payload: {} },
      { title: "malformed — no class" },
    ],
    { proposal_ttl_hours: 48 },
    {
      dispatch: (agent, intent) => {
        dispatched.push({ agent: agent.key, ...intent });
        return Promise.resolve({ kind: "proposed", proposalId: "x", downgraded: false });
      },
      notify: (input) => {
        notifications.push(input as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
      now: () => now,
    },
  );

  assertEquals(tally, { filed: 2, dropped: 0, skipped: 1 });
  // TTL applied: 48h from now.
  assertEquals(dispatched[0].expiresAt, "2026-07-06T00:00:00.000Z");
  // ONE notification for the whole run, naming the count.
  assertEquals(notifications.length, 1);
  assert(String(notifications[0].title).includes("2 proposals"));
  assertEquals(DEFAULT_PROPOSAL_TTL_HOURS, 72);
});

Deno.test("L0 suppressions count as dropped and trigger NO notification", async () => {
  const notifications: unknown[] = [];
  const tally = await fileProposalsFromRun(
    { id: "a1", key: "sentinel", status: "enabled", autonomy: null },
    "run-1",
    [{ action_class: "retry_job", title: "T", summary: "s" }],
    {},
    {
      dispatch: () =>
        Promise.resolve({
          kind: "dropped",
          finding: { note: "would have proposed: T" },
        }),
      notify: (input) => {
        notifications.push(input);
        return Promise.resolve();
      },
    },
  );
  assertEquals(tally, { filed: 0, dropped: 1, skipped: 0 });
  assertEquals(notifications.length, 0);
});
