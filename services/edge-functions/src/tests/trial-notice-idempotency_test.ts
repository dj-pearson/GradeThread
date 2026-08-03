// US-2319: a trial-ending warning that a missed cron day cannot delete.
//
// The only dedupe was the exact-day window (`daysLeft === 3`), and the job's own
// comment already named the consequence: one missed run and the customer gets NO
// warning before their trial ends, silently, because a notice nobody received
// leaves no trace. A same-day manual re-run double-sent for the same reason.
//
// 00523 adds users.trial_notice_sent_at, which is what lets the window widen
// from "exactly the third day" to "due or overdue, not yet sent" without ever
// repeating. These pin both halves, because either alone is a bug: the marker
// without the wider window still misses the day, and the wider window without
// the marker mails someone three times.

import { assert, assertEquals } from "@std/assert";

// The route transitively imports the service-role client, which throws at module
// load without these.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { shouldSendTrialNotice } = await import("../routes/jobs-trial-expiry.ts");

Deno.test("the notice still goes out on the day it is due", () => {
  assertEquals(
    shouldSendTrialNotice({ daysLeft: 3, alreadyNotifiedAt: null }),
    true,
  );
});

Deno.test("a MISSED day still sends, late, instead of never", () => {
  // The whole story. The cron did not run on day 3; day 2 and day 1 must still
  // catch this customer, because the alternative is that they are downgraded
  // with no warning at all and nobody finds out.
  assertEquals(shouldSendTrialNotice({ daysLeft: 2, alreadyNotifiedAt: null }), true);
  assertEquals(shouldSendTrialNotice({ daysLeft: 1, alreadyNotifiedAt: null }), true);
  assertEquals(shouldSendTrialNotice({ daysLeft: 0, alreadyNotifiedAt: null }), true);
});

Deno.test("the marker is what stops the wider window repeating", () => {
  // Widening the window WITHOUT the marker would mail the same person on day 3,
  // day 2, day 1 and day 0. The two changes only make sense together.
  for (const daysLeft of [3, 2, 1, 0]) {
    assertEquals(
      shouldSendTrialNotice({
        daysLeft,
        alreadyNotifiedAt: "2026-08-01T00:00:00.000Z",
      }),
      false,
      `daysLeft ${daysLeft} re-sent despite a marker`,
    );
  }
});

Deno.test("a lapsed trial gets nothing", () => {
  // The downgrade is the event. A "3 days left" mail about a trial that already
  // ended is worse than silence, and the widened window must not reach back.
  assertEquals(shouldSendTrialNotice({ daysLeft: -1, alreadyNotifiedAt: null }), false);
  assertEquals(shouldSendTrialNotice({ daysLeft: -30, alreadyNotifiedAt: null }), false);
});

Deno.test("no trial end date means no notice", () => {
  assertEquals(shouldSendTrialNotice({ daysLeft: null, alreadyNotifiedAt: null }), false);
});

Deno.test("a trial further out than the window is not warned early", () => {
  assertEquals(shouldSendTrialNotice({ daysLeft: 4, alreadyNotifiedAt: null }), false);
  assertEquals(shouldSendTrialNotice({ daysLeft: 14, alreadyNotifiedAt: null }), false);
});

Deno.test("the job reads the real marker and stamps AFTER the send", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/jobs-trial-expiry.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");

  // The hardcoded null was the defect, and it is the kind that reads as
  // finished code.
  assertEquals(
    /alreadyNotifiedAt:\s*null/.test(code),
    false,
    "the marker is still hardcoded null",
  );
  assert(code.includes("alreadyNotifiedAt: row.trial_notice_sent_at"));

  // Ordering, by index. Stamping BEFORE the send loses the notice permanently on
  // a crash; stamping after risks one duplicate. US-2314 settled that trade the
  // same way, and a later edit that "tidies" this into one write would silently
  // reverse it.
  const sendAt = code.indexOf("sendTrialExpiringEmail(");
  const stampAt = code.indexOf("trial_notice_sent_at: new Date");
  assert(sendAt > -1 && stampAt > -1, "send or stamp is gone");
  assert(sendAt < stampAt, "the marker must be stamped AFTER the send is handed off");
});

Deno.test("the marker column is protected from the account owner", () => {
  // guard_users_protected_columns is a DENYLIST: a new column is writable by the
  // account owner unless it is named. A trialist could otherwise suppress their
  // own warning — self-harm only, which is exactly how the entitlement holes in
  // US-2283 were justified.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00523_users_trial_notice_sent_at.sql",
      import.meta.url,
    ),
  );
  assert(sql.includes("ADD COLUMN IF NOT EXISTS trial_notice_sent_at"));
  assert(
    sql.includes("NEW.trial_notice_sent_at IS DISTINCT FROM OLD.trial_notice_sent_at"),
    "the column is not in the protected-columns guard",
  );
  // US-1108: idempotent + self-recording.
  assert(sql.includes("insert into public.applied_migrations (version) values ('00523')"));
});

Deno.test("the buyer digest resolves the recipient BEFORE claiming the period", () => {
  // US-2319 AC3, the same class in another job. The claim used to come first, so
  // a buyer with no email burned that period's claim and sent nothing —
  // permanently, because the claim is what stops the next run retrying.
  const src = Deno.readTextFileSync(
    new URL("../routes/jobs-buyer-digest.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
  const resolveAt = code.indexOf('.select("email")');
  const claimAt = code.indexOf('from("buyer_notification_log").insert(');
  assert(resolveAt > -1 && claimAt > -1, "resolve or claim is gone");
  assert(resolveAt < claimAt, "the claim must not be spent before there is a recipient");
});

Deno.test("a failed digest send RELEASES the claim", () => {
  // Without the release, the caught failure leaves the row, the next run reads
  // 23505 and skips, and that period's digest is lost with nothing saying so.
  const src = Deno.readTextFileSync(
    new URL("../routes/jobs-buyer-digest.ts", import.meta.url),
  );
  const catchBlock = src.slice(src.indexOf("[buyer-digest] send failed"));
  assert(
    /\.from\("buyer_notification_log"\)\s*\r?\n?\s*\.delete\(\)/.test(catchBlock),
    "the failure path does not release the claim",
  );
});
