// US-2933: the deadline reminder pass.
//
// Two properties carry the whole feature, and both are easy to get wrong in a
// way that looks fine:
//
//   1. The bands must not swallow each other. A case that already got its 48h
//      reminder has a claim on `deadline_48h`; the 12h reminder is a DIFFERENT
//      claim, so it still fires. Share one status and the second reminder — the
//      one that actually saves the case — silently never goes out.
//   2. An overdue case is not reminded. The deadline has passed and eBay is
//      deciding; a notification then is a reproach, not a prompt.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { claimKindFor, remindDueCasesForUser, reminderTier } = await import(
  "../lib/post-sale-reminders.ts"
);
import type { DueCase, ReminderDeps } from "../lib/post-sale-reminders.ts";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

Deno.test("reminderTier picks the band by hours left", () => {
  assertEquals(reminderTier(at(72), NOW), null, "still far off");
  assertEquals(reminderTier(at(48), NOW), "48h", "exactly 48h is the 48h band");
  assertEquals(reminderTier(at(24), NOW), "48h");
  assertEquals(reminderTier(at(12), NOW), "12h", "exactly 12h is the 12h band");
  assertEquals(reminderTier(at(1), NOW), "12h");
});

Deno.test("reminderTier never fires on a passed or unreadable deadline", () => {
  assertEquals(reminderTier(at(-1), NOW), null);
  assertEquals(reminderTier(null, NOW), null);
  assertEquals(reminderTier(undefined, NOW), null);
  assertEquals(reminderTier("not a date", NOW), null);
});

Deno.test("claimKindFor maps payment_dispute onto the ledger's vocabulary", () => {
  // The claim ledger predates this table and calls it `dispute`. Get this wrong
  // and the dedupe key does not match the one the opening notification used.
  assertEquals(claimKindFor("payment_dispute"), "dispute");
  assertEquals(claimKindFor("return"), "return");
  assertEquals(claimKindFor("inquiry"), "inquiry");
  assertEquals(claimKindFor("case"), "case");
  assertEquals(claimKindFor("cancellation"), "cancellation");
});

function makeDeps(cases: DueCase[], over: Partial<ReminderDeps> = {}) {
  const seen = new Set<string>();
  const sent: Array<{ id: string; tier: string }> = [];
  const deps: ReminderDeps = {
    loadDueCases: () => Promise.resolve(cases),
    // Models the unique constraint: first claim wins, repeats are duplicates.
    claim: (ownerId, kind, externalId, status) => {
      const key = `${ownerId}|${kind}|${externalId}|${status}`;
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
    release: (ownerId, kind, externalId, status) => {
      seen.delete(`${ownerId}|${kind}|${externalId}|${status}`);
      return Promise.resolve();
    },
    notify: (ev) => {
      sent.push({ id: ev.externalId, tier: ev.tier });
      return Promise.resolve();
    },
    now: () => NOW,
    ...over,
  };
  return { deps, sent, seen };
}

const CASE = (respondBy: string, id = "r1"): DueCase => ({
  caseType: "return",
  externalId: id,
  externalOrderId: "ord1",
  reason: "NOT_AS_DESCRIBED",
  respondBy,
  amountCents: 4200,
  currency: "USD",
});

Deno.test("a case inside 48h is reminded once, not on every sweep", async () => {
  const { deps, sent } = makeDeps([CASE(at(30))]);
  assertEquals(await remindDueCasesForUser("u1", deps), 1);
  assertEquals(await remindDueCasesForUser("u1", deps), 0, "a re-sweep sends nothing new");
  assertEquals(sent, [{ id: "r1", tier: "48h" }]);
});

Deno.test("the 12h reminder still fires after the 48h one — separate claims", async () => {
  // The property the whole two-band design rests on. One shared claim status
  // would make the second, more urgent reminder silently never go out.
  const { deps, sent, seen } = makeDeps([CASE(at(30))]);
  await remindDueCasesForUser("u1", deps);
  assertEquals(sent.length, 1);

  // Same case, now inside 12 hours. Same claim set, so the 48h claim is still held.
  const later = makeDeps([CASE(at(6))], {
    claim: deps.claim,
    release: deps.release,
    notify: deps.notify,
  });
  // Reuse the SAME notify sink so both sends land in one list.
  later.deps.notify = deps.notify;
  await remindDueCasesForUser("u1", later.deps);
  assertEquals(sent.map((s) => s.tier), ["48h", "12h"]);
  assert(seen.size >= 2, "two distinct claims, not one");
});

Deno.test("an overdue case is not reminded", async () => {
  const { deps, sent } = makeDeps([CASE(at(-3))]);
  assertEquals(await remindDueCasesForUser("u1", deps), 0);
  assertEquals(sent.length, 0);
});

Deno.test("a failed notification releases its claim so the next sweep retries", async () => {
  let fail = true;
  const { deps, sent } = makeDeps([CASE(at(30))], {
    notify: (ev) => {
      if (fail) return Promise.reject(new Error("smtp down"));
      sent.push({ id: ev.externalId, tier: ev.tier });
      return Promise.resolve();
    },
  });
  assertEquals(await remindDueCasesForUser("u1", deps), 0, "nothing counted as sent");
  fail = false;
  assertEquals(await remindDueCasesForUser("u1", deps), 1, "the retry goes through");
});

Deno.test("a load failure is zero reminders, not a thrown sweep", async () => {
  const { deps } = makeDeps([], {
    loadDueCases: () => Promise.reject(new Error("db down")),
  });
  assertEquals(await remindDueCasesForUser("u1", deps), 0);
});
