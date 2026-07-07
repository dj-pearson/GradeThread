// US-1702: review workflow — state transitions + that a dismissed/snoozed rec is
// never applyable, plus recordDecision writes the audit + status.
import { assert, assertEquals } from "@std/assert";
import {
  canDecide,
  isApplyable,
  isExecutable,
  nextStatus,
  recordDecision,
} from "../lib/ads-decisions.ts";

Deno.test("canDecide — proposed/approved/snoozed actionable; terminal states not", () => {
  assert(canDecide("proposed"));
  assert(canDecide("approved"));
  // Snoozed is ALWAYS decidable — the operator can un-snooze / re-decide early.
  assert(canDecide("snoozed"));
  assertEquals(canDecide("applied"), false);
  assertEquals(canDecide("dismissed"), false);
  assertEquals(canDecide("failed"), false);
});

Deno.test("isExecutable — report-only change types are not executable", () => {
  assert(isExecutable("google_ads", "pause_campaign"));
  assert(isExecutable("apple_search_ads", "adjust_bid"));
  assertEquals(isExecutable("google_ads", "fix_rsa_gap"), false);
});

Deno.test("nextStatus + isApplyable — only approved is applyable", () => {
  assertEquals(nextStatus("approve"), "approved");
  assertEquals(nextStatus("dismiss"), "dismissed");
  assertEquals(nextStatus("snooze"), "snoozed");
  assert(isApplyable("approved"));
  assertEquals(isApplyable("proposed"), false);
  assertEquals(isApplyable("dismissed"), false);
  assertEquals(isApplyable("snoozed"), false);
});

// Stateful fake with one recommendation row. Supports the guarded update chain
// `.update(patch).eq("id",…).eq("status",…).select("id")` and a bare
// `.update(patch).eq("id",…)` (the compensating revert), plus `.insert()`.
function fakeSupabase(
  rec: Record<string, unknown>,
  opts: { auditFails?: boolean; statusRace?: boolean } = {},
) {
  const audits: Record<string, unknown>[] = [];
  let updated: Record<string, unknown> | null = null;
  function from(table: string) {
    return {
      select: (_cols?: string) => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: table === "ads_recommendations" ? rec : null, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        // A racing status change makes the guarded update match 0 rows. Record
        // the patch but DON'T mutate `rec` — a real read returns a detached copy,
        // so recordDecision's captured rec.status stays the read snapshot.
        const matched = !(table === "ads_recommendations" && opts.statusRace);
        if (matched && table === "ads_recommendations") updated = patch;
        const result = { data: matched ? [{ id: rec.id }] : [], error: null };
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          eq: () => chain,
          select: () => Promise.resolve(result),
          // Awaiting the chain directly (compensating revert has no .select()).
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        };
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        if (opts.auditFails && table === "ads_change_audit") {
          return Promise.resolve({ error: { message: "boom" } });
        }
        if (table === "ads_change_audit") audits.push(row);
        return Promise.resolve({ error: null });
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from } as any, audits, get updated() { return updated; } };
}

function baseRec(over: Record<string, unknown> = {}) {
  return {
    id: "r1", platform: "google_ads", change_type: "pause_campaign", target_type: "campaign",
    target_resource: "111", status: "proposed", snooze_until: null, dismiss_reason: null,
    payload: { campaignId: "111" }, ...over,
  };
}

Deno.test("recordDecision(dismiss) sets status + writes a decision audit row", async () => {
  const f = fakeSupabase(baseRec());
  const r = await recordDecision(f.client, { recId: "r1", decision: "dismiss", actorUserId: "admin-1", reason: "irrelevant" });
  assertEquals(r.ok, true);
  assertEquals(r.status, "dismissed");
  assertEquals(f.audits.length, 1);
  assertEquals(f.audits[0].action, "decision");
  assertEquals((f.audits[0].result as { decision: string }).decision, "dismiss");
  assertEquals(f.audits[0].owner_user_id, "admin-1");
});

Deno.test("recordDecision(snooze) requires an until date", async () => {
  const f = fakeSupabase(baseRec({ payload: {} }));
  const noDate = await recordDecision(f.client, { recId: "r1", decision: "snooze", actorUserId: "a" });
  assertEquals(noDate.ok, false);
  assertEquals(noDate.httpStatus, 400);
  const ok = await recordDecision(f.client, { recId: "r1", decision: "snooze", actorUserId: "a", until: "2026-08-01T00:00:00Z" });
  assertEquals(ok.status, "snoozed");
});

Deno.test("recordDecision refuses to decide a terminal (dismissed) rec", async () => {
  const f = fakeSupabase(baseRec({ status: "dismissed" }));
  const r = await recordDecision(f.client, { recId: "r1", decision: "approve", actorUserId: "a" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 409);
});

Deno.test("recordDecision approves a snoozed rec (early un-snooze) and clears snooze_until", async () => {
  const f = fakeSupabase(baseRec({ status: "snoozed", snooze_until: "2999-01-01T00:00:00Z" }));
  const r = await recordDecision(f.client, { recId: "r1", decision: "approve", actorUserId: "a" });
  assertEquals(r.ok, true);
  assertEquals(r.status, "approved");
  assertEquals(f.updated?.snooze_until, null);
});

Deno.test("recordDecision refuses to approve a report-only rec", async () => {
  const f = fakeSupabase(baseRec({ change_type: "fix_rsa_gap" }));
  const r = await recordDecision(f.client, { recId: "r1", decision: "approve", actorUserId: "a" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 422);
  assertEquals(f.audits.length, 0);
});

Deno.test("recordDecision 409s (no clobber) when the status changed under us", async () => {
  const f = fakeSupabase(baseRec({ status: "approved" }), { statusRace: true });
  const r = await recordDecision(f.client, { recId: "r1", decision: "dismiss", actorUserId: "a" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 409);
  assertEquals(f.audits.length, 0);
});

Deno.test("recordDecision reverts the status flip when the audit insert fails", async () => {
  const f = fakeSupabase(baseRec(), { auditFails: true });
  const r = await recordDecision(f.client, { recId: "r1", decision: "dismiss", actorUserId: "a", reason: "x" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 500);
  assertEquals(f.audits.length, 0);
  // Compensating revert restored the original status.
  assertEquals(f.updated?.status, "proposed");
});
