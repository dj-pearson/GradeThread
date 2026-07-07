// US-1702: review workflow — state transitions + that a dismissed/snoozed rec is
// never applyable, plus recordDecision writes the audit + status.
import { assert, assertEquals } from "@std/assert";
import {
  canDecide,
  isApplyable,
  nextStatus,
  recordDecision,
} from "../lib/ads-decisions.ts";

Deno.test("canDecide — actionable states only", () => {
  assert(canDecide("proposed"));
  assert(canDecide("approved"));
  assertEquals(canDecide("applied"), false);
  assertEquals(canDecide("dismissed"), false);
  assertEquals(canDecide("failed"), false);
  // Snoozed: asleep until snooze_until passes.
  assertEquals(canDecide("snoozed", "2999-01-01T00:00:00Z", new Date("2026-07-07")), false);
  assertEquals(canDecide("snoozed", "2026-07-01T00:00:00Z", new Date("2026-07-07")), true);
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

// Stateful fake with one recommendation row.
function fakeSupabase(rec: Record<string, unknown>) {
  const audits: Record<string, unknown>[] = [];
  let updated: Record<string, unknown> | null = null;
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      update: (patch: Record<string, unknown>) => {
        if (table === "ads_recommendations") { updated = patch; Object.assign(rec, patch); }
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (row: Record<string, unknown>) => { if (table === "ads_change_audit") audits.push(row); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "ads_recommendations" ? rec : null, error: null }),
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from: (t: string) => builder(t) } as any, audits, get updated() { return updated; } };
}

Deno.test("recordDecision(dismiss) sets status + writes a decision audit row", async () => {
  const f = fakeSupabase({ id: "r1", platform: "google_ads", change_type: "pause_campaign", target_type: "campaign", target_resource: "111", status: "proposed", snooze_until: null, payload: { campaignId: "111" } });
  const r = await recordDecision(f.client, { recId: "r1", decision: "dismiss", actorUserId: "admin-1", reason: "irrelevant" });
  assertEquals(r.ok, true);
  assertEquals(r.status, "dismissed");
  assertEquals(f.audits.length, 1);
  assertEquals(f.audits[0].action, "decision");
  assertEquals((f.audits[0].result as { decision: string }).decision, "dismiss");
  assertEquals(f.audits[0].owner_user_id, "admin-1");
});

Deno.test("recordDecision(snooze) requires an until date", async () => {
  const f = fakeSupabase({ id: "r1", platform: "google_ads", change_type: "pause_campaign", target_type: null, target_resource: "", status: "proposed", snooze_until: null, payload: {} });
  const noDate = await recordDecision(f.client, { recId: "r1", decision: "snooze", actorUserId: "a" });
  assertEquals(noDate.ok, false);
  assertEquals(noDate.httpStatus, 400);
  const ok = await recordDecision(f.client, { recId: "r1", decision: "snooze", actorUserId: "a", until: "2026-08-01T00:00:00Z" });
  assertEquals(ok.status, "snoozed");
});

Deno.test("recordDecision refuses to decide a terminal (dismissed) rec", async () => {
  const f = fakeSupabase({ id: "r1", platform: "google_ads", change_type: "pause_campaign", target_type: null, target_resource: "", status: "dismissed", snooze_until: null, payload: {} });
  const r = await recordDecision(f.client, { recId: "r1", decision: "approve", actorUserId: "a" });
  assertEquals(r.ok, false);
  assertEquals(r.httpStatus, 409);
});
