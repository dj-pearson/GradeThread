// US-2316 AC2: a broadcast recipient is emailed at most once per campaign.
//
// The reservation used to be an UPSERT to `pending`, which always succeeds — so
// two workers on one recipient both "reserved" and both sent. The done-set built
// at the start of a tick only holds rows already `sent` or `skipped`, so a claim
// in progress was invisible to it, and the only remaining backstop was the
// platform-wide 1/day frequency cap: a policy control, not an idempotency one.
//
// The claim is now an INSERT, so the unique index on
// (campaign_id, user_id, channel) picks the winner atomically in the database.
// These cases pin what a LOSER does, which is where every duplicate came from.

import { assertEquals } from "@std/assert";
import { isUniqueViolation, verdictForExistingRow } from "../lib/campaign-claim.ts";

Deno.test("a finalised row is never resent", () => {
  assertEquals(verdictForExistingRow({ status: "sent" }), {
    action: "already",
    status: "sent",
  });
  assertEquals(verdictForExistingRow({ status: "skipped" }), {
    action: "already",
    status: "skipped",
  });
});

Deno.test("a PENDING row is left alone — this is the whole fix", () => {
  // The old upsert overwrote pending and sent again. Standing down here is what
  // makes a duplicate impossible, and it is a deliberate trade: a worker that
  // died between claiming and enqueuing loses that recipient until someone sets
  // the row to `failed`, which a retry then reclaims.
  assertEquals(verdictForExistingRow({ status: "pending" }), { action: "in_flight" });
});

Deno.test("a FAILED row is reclaimable, and only from failed", () => {
  const v = verdictForExistingRow({ status: "failed" });
  assertEquals(v, { action: "reclaim", from: "failed" });
  // The `from` is what the conditional update matches on. If it ever named a
  // status two workers could both hold, the reclaim would stop being exclusive.
  assertEquals(v.action === "reclaim" && v.from, "failed");
});

Deno.test("an unknown status does not authorise a send", () => {
  // A status added later — 'bounced', 'suppressed', anything — must not fall
  // through to sending. The safe answer to "what does this mean" is: not ours.
  assertEquals(verdictForExistingRow({ status: "bounced" }), { action: "in_flight" });
  assertEquals(verdictForExistingRow({ status: "" }), { action: "in_flight" });
});

Deno.test("a vanished row is not ours to send", () => {
  // The insert conflicted but the follow-up read found nothing: a concurrent
  // delete, or a read that raced the write. Sending here would be sending on no
  // information at all.
  assertEquals(verdictForExistingRow(null), { action: "in_flight" });
});

Deno.test("only 23505 means another worker won the claim", () => {
  assertEquals(isUniqueViolation({ code: "23505" }), true);
  // Everything else is a real error and must reach the failure path — treating
  // a connection error as "someone else has it" would silently drop recipients.
  assertEquals(isUniqueViolation({ code: "23503" }), false);
  assertEquals(isUniqueViolation({}), false);
  assertEquals(isUniqueViolation(null), false);
});

Deno.test("the reservation is an INSERT, not an upsert", () => {
  // The property, at the one call site that matters. An upsert here cannot fail,
  // so it cannot pick a winner — which is the entire defect.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-growth.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("async function sendCampaignEmailDurable"));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
  assertEquals(
    /\.upsert\(/.test(code),
    false,
    "the claim must not be an upsert — an upsert always wins and never picks",
  );
  assertEquals(/\.insert\(\{/.test(code), true, "the claim insert is gone");
  assertEquals(code.includes("isUniqueViolation("), true);
  assertEquals(code.includes("verdictForExistingRow("), true);
});

Deno.test("the reclaim update is conditional on the status it read", () => {
  // Without `.eq("status", verdict.from)` two workers could both reclaim one
  // failed row and both send. The conditional is what makes exactly one of them
  // get a row back.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-growth.ts", import.meta.url),
  );
  assertEquals(src.includes('.eq("status", verdict.from)'), true);
  assertEquals(
    src.includes("if (!reclaimed) return \"in_flight\";"),
    true,
    "a reclaim that moved no row must not send",
  );
});

Deno.test("a claim we did not win is not counted as a failure", () => {
  // It would otherwise inflate the failure counter US-2312 alerts on, turning
  // a healthy resumed campaign into a paging alert.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-growth.ts", import.meta.url),
  );
  const hits = src.match(/outcome === "in_flight"\) stats\.in_flight\+\+/g) ?? [];
  assertEquals(hits.length, 2, "both call sites must count in_flight separately");
  assertEquals(src.includes("in_flight: 0,"), true, "the counter must be initialised");
});

Deno.test("the newsletter A/B job has no unordered row cap left", () => {
  // US-2316 AC4 (first half). One constant capped three reads, each broken in a
  // different way: the confirmed-subscriber list silently never mailed anyone
  // past 1000, the already-sent ledger dropped its tail and mailed those people
  // twice, and the holdout stats picked a winning subject from an arbitrary
  // sample. None had an ORDER BY, so which rows fell outside changed run to run.
  const src = Deno.readTextFileSync(
    new URL("../lib/newsletter-ab-job.ts", import.meta.url),
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
  assertEquals(
    /MAX_SEND_RECIPIENTS/.test(code),
    false,
    "the cap constant is back — page the read instead",
  );
  // Paged AND ordered. Paging without an order can skip a row at a boundary,
  // which is the same missing-subscriber bug wearing a different hat.
  const pages = code.match(/fetchAllPages</g) ?? [];
  assertEquals(pages.length, 3, "all three reads must page");
  const ranges = code.match(/\.range\(from, to\)/g) ?? [];
  const orders = code.match(/\.order\("email", \{ ascending: true \}\)/g) ?? [];
  assertEquals(orders.length, ranges.length, "every paged read needs an ORDER BY");
});
