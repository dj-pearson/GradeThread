// US-2145 §1a: the seller notice on a red_flags verdict.

// authenticity-notify imports notify.ts, which loads the service-role supabase
// client, so set dummy env first and dynamic-import.
import { assert, assertEquals } from "@std/assert";
import type { NotifyInput } from "../lib/notify.ts";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  AUTHENTICITY_APPEAL_SLA_BUSINESS_DAYS,
  buildAuthenticityFlagNotice,
  notifyAuthenticityFlagged,
} = await import("../lib/authenticity-notify.ts");

function spy() {
  const sent: { userId: string; input: NotifyInput }[] = [];
  return {
    sent,
    deps: { notify: (userId: string, input: NotifyInput) => (sent.push({ userId, input }), Promise.resolve()) },
  };
}

Deno.test("fires on red_flags", async () => {
  const s = spy();
  const sentIt = await notifyAuthenticityFlagged("u1", "red_flags", "Gucci belt", "/x", s.deps);
  assertEquals(sentIt, true);
  assertEquals(s.sent.length, 1);
  assertEquals(s.sent[0].userId, "u1");
});

Deno.test("does NOT fire on any other verdict", async () => {
  // An inconclusive verdict is not a finding. Telling a seller about one is
  // noise, and it invites appeals against nothing.
  for (const v of ["likely_authentic", "inconclusive", null]) {
    const s = spy();
    assertEquals(await notifyAuthenticityFlagged("u1", v, "t", "/x", s.deps), false);
    assertEquals(s.sent.length, 0);
  }
});

Deno.test("does not fire without a user", async () => {
  const s = spy();
  assertEquals(await notifyAuthenticityFlagged("", "red_flags", "t", "/x", s.deps), false);
  assertEquals(s.sent.length, 0);
});

Deno.test("the notice states the SLA and frames the verdict as an estimate", () => {
  const n = buildAuthenticityFlagNotice("Gucci belt", "/dashboard/submissions/1");

  assert(n.message.includes(String(AUTHENTICITY_APPEAL_SLA_BUSINESS_DAYS)));
  assert(n.message.includes("business days"), "an appeal with no stated turnaround cannot be planned around");
  // The framing is load-bearing: the pass has no measured error rate, so the
  // notice must not assert the item IS counterfeit.
  assert(n.message.includes("estimate"));
  assert(n.message.includes("not a determination"));
  assert(!/counterfeit|fake/i.test(n.message), "must not accuse — this is an unvalidated photo-only read");
  assert(n.message.includes("contest"), "the appeal must be discoverable from the notice");
});

Deno.test("rides the existing dispute channel", () => {
  // An appeal IS a dispute; inventing a notification type the user's preferences
  // do not know about would make it unsuppressable.
  assertEquals(buildAuthenticityFlagNotice("x", null).type, "dispute_update");
});

Deno.test("falls back to a usable link and label", () => {
  const n = buildAuthenticityFlagNotice(null, null);
  assertEquals(n.link, "/dashboard/submissions");
  assert(n.message.startsWith("Your item"));
});
