// US-2312: a cron that answers 200 while every unit of work inside it failed
// used to be recorded as a success and alert on nothing. These pin the body
// reading, the ledger status it produces, and the clone that makes it possible.

import { assert, assertEquals } from "@std/assert";
import {
  cloneJsonBody,
  cronRunStatusFor,
  jobFailureTitle,
  readJobOutcome,
} from "../lib/cron-run-outcome.ts";

// ── readJobOutcome ───────────────────────────────────────────────────

Deno.test("US-2312: a clean run reports no failures and zero rows, not null", () => {
  // The zero matters: rows_processed was DEFINED and never populated, so "ran
  // every hour and did nothing all week" was not a queryable state.
  const o = readJobOutcome({ ok: true });
  assertEquals(o.failedItems, 0);
  assertEquals(o.failures, {});
  assertEquals(o.rowsProcessed, 0);
});

Deno.test("US-2312: the payout sweeps' own shape — 200 with failed:N — is a failure", () => {
  // jobs-affiliate-payouts.ts / jobs-consignor-payouts.ts return exactly this.
  const o = readJobOutcome({
    ok: true,
    scanned: 120,
    transferred: 0,
    queued: 0,
    failed: 120,
    skipped: 0,
  });
  assertEquals(o.failedItems, 120);
  assertEquals(o.failures, { failed: 120 });
  assertEquals(o.rowsProcessed, 120); // from `scanned`
  assertEquals(cronRunStatusFor(200, o.failedItems), "error");
});

Deno.test("US-2312: guarantee-pool discrepancies count as failed units", () => {
  // jobs-guarantee-pool.ts returns 200 {ok:true, discrepancies:N} — an
  // auto_approved claim with no pool drawdown is unaccounted exposure.
  const o = readJobOutcome({
    ok: true,
    period: "2026-08",
    activeSubs: 40,
    accruedCents: 12_000,
    reconciledClaims: 5,
    discrepancies: 2,
  });
  assertEquals(o.failedItems, 2);
  assertEquals(o.failures, { discrepancies: 2 });
  assertEquals(cronRunStatusFor(200, o.failedItems), "error");
});

Deno.test("US-2312: zero-valued and skipped runs stay successes", () => {
  assertEquals(readJobOutcome({ ok: true, failed: 0, scanned: 0 }).failedItems, 0);
  // The lock-held / disabled early returns must never look like failures.
  const skipped = readJobOutcome({ ok: true, skipped: true, reason: "disabled" });
  assertEquals(skipped.failedItems, 0);
  assertEquals(skipped.rowsProcessed, 0);
  assertEquals(cronRunStatusFor(200, skipped.failedItems), "success");
});

Deno.test("US-2312: an array of failures counts by length", () => {
  const o = readJobOutcome({ ok: true, errors: ["a", "b", "c"] });
  assertEquals(o.failedItems, 3);
  assertEquals(o.failures, { errors: 3 });
});

Deno.test("US-2312: two failure counters give the MAX, not the sum", () => {
  // A job reporting both is usually describing one set of items twice; summing
  // would report 8 failures where 5 items failed.
  const o = readJobOutcome({ ok: true, failed: 5, errors: 3 });
  assertEquals(o.failedItems, 5);
  assertEquals(o.failures, { failed: 5, errors: 3 }); // breakdown kept in full
});

Deno.test("US-2312: an explicit rowsProcessed outranks the conventional keys", () => {
  const o = readJobOutcome({ ok: true, rowsProcessed: 7, scanned: 999, count: 1 });
  assertEquals(o.rowsProcessed, 7);
});

Deno.test("US-2312: a non-object body leaves rowsProcessed unknown", () => {
  // Nothing to count and nothing to claim — null, not a fabricated 0.
  assertEquals(readJobOutcome(null).rowsProcessed, null);
  assertEquals(readJobOutcome("ok").rowsProcessed, null);
  assertEquals(readJobOutcome([1, 2, 3]).rowsProcessed, null);
  assertEquals(readJobOutcome(undefined).failedItems, 0);
});

Deno.test("US-2312: a negative or non-finite counter is ignored, not trusted", () => {
  const o = readJobOutcome({ ok: true, failed: -4, scanned: Number.NaN });
  assertEquals(o.failedItems, 0);
  assertEquals(o.rowsProcessed, 0);
});

// ── diagnostics (US-3112) ────────────────────────────────────────────

Deno.test("US-3112: a job's sentences survive into the outcome, not just its counts", () => {
  // The shape jobs-ebay-notification-reconcile.ts now returns. Before this the
  // ledger kept `{failures:{errors:12}}` and the twelve causes lived only in a
  // container log that rotated, which is why the story asking somebody to
  // diagnose them needed access nobody has.
  const o = readJobOutcome({
    ok: true,
    errors: [{ topicId: "ITEM_SOLD" }, { topicId: "ITEM_PAID" }],
    diagnostics: [
      "subscribe failed for ITEM_SOLD: Destination is disabled",
      "subscribe failed for ITEM_PAID: Destination is disabled",
    ],
  });
  assertEquals(o.failedItems, 2);
  assertEquals(o.diagnostics.length, 2);
  assert(o.diagnostics[0]?.includes("ITEM_SOLD"), o.diagnostics[0]);
});

Deno.test("US-3112: diagnostics never invent a failure and never mask one", () => {
  // `diagnostics` is not a FAILURE_KEY: a job that explains itself on a clean
  // run stays green, and one that explains a real failure stays red.
  const clean = readJobOutcome({ ok: true, diagnostics: ["nothing to do"] });
  assertEquals(clean.failedItems, 0);
  assertEquals(cronRunStatusFor(200, clean.failedItems), "success");

  const red = readJobOutcome({ ok: true, failed: 3, diagnostics: ["three timed out"] });
  assertEquals(cronRunStatusFor(200, red.failedItems), "error");
});

Deno.test("US-3112: diagnostics are bounded and truncated by the READER", () => {
  // Enforced here rather than trusted from the job, because `detail` is written
  // on every run of every cron: a misconfiguration emitting one line per topic
  // per tick would otherwise grow the column without limit.
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  assertEquals(readJobOutcome({ ok: true, diagnostics: many }).diagnostics.length, 10);

  const long = readJobOutcome({ ok: true, diagnostics: ["x".repeat(1000)] });
  assertEquals(long.diagnostics[0]?.length, 303); // 300 + "..."
  assert(long.diagnostics[0]?.endsWith("..."));
});

Deno.test("US-3112: a junk diagnostics value degrades to no lines, never to noise", () => {
  // An object entry would stringify to "[object Object]" — a line that costs a
  // reader time and tells them nothing. Dropped instead.
  assertEquals(readJobOutcome({ ok: true, diagnostics: "not an array" }).diagnostics, []);
  assertEquals(readJobOutcome({ ok: true, diagnostics: 12 }).diagnostics, []);
  assertEquals(readJobOutcome({ ok: true }).diagnostics, []);
  assertEquals(
    readJobOutcome({ ok: true, diagnostics: [{ topicId: "X" }, "  ", null, "real"] })
      .diagnostics,
    ["real"],
  );
});

// ── cronRunStatusFor ─────────────────────────────────────────────────

Deno.test("US-2312: ledger status covers HTTP failure AND body-reported failure", () => {
  assertEquals(cronRunStatusFor(200, 0), "success");
  assertEquals(cronRunStatusFor(200, 1), "error"); // the whole point of the story
  assertEquals(cronRunStatusFor(500, 0), "error");
  assertEquals(cronRunStatusFor(401, 3), "error");
});

// ── jobFailureTitle ──────────────────────────────────────────────────

Deno.test("US-2312: the 2xx-with-failures title says the request succeeded", () => {
  const outcome = readJobOutcome({ ok: true, failed: 12 });
  const title = jobFailureTitle({
    jobName: "consignor-payouts",
    httpStatus: 200,
    outcome,
  });
  assert(title.includes("HTTP 200"), title);
  assert(title.includes("12 failed item(s)"), title);
  assert(title.includes("failed=12"), title);
  // The HTTP-failure wording is unchanged from US-906 so existing alert rules
  // and muted-type expectations keep matching.
  assertEquals(
    jobFailureTitle({ jobName: "gsc-sync", httpStatus: 502, outcome }),
    'Background job "gsc-sync" failed (HTTP 502)',
  );
});

// ── cloneJsonBody ────────────────────────────────────────────────────

Deno.test("US-2312: reading the body clone leaves the caller's response intact", async () => {
  // The recorder runs AFTER the handler and before the response is sent. If it
  // consumed the real body, the cron would receive an empty response.
  const res = Response.json({ ok: true, failed: 2 });
  const parsed = cloneJsonBody(res);
  assert(parsed !== null);
  assertEquals(await parsed, { ok: true, failed: 2 });
  assertEquals(res.bodyUsed, false);
  assertEquals(await res.json(), { ok: true, failed: 2 });
});

Deno.test("US-2312: a non-JSON response is skipped rather than mis-parsed", () => {
  const html = new Response("<h1>nope</h1>", {
    headers: { "content-type": "text/html" },
  });
  assertEquals(cloneJsonBody(html), null);
  assertEquals(html.bodyUsed, false);
});

Deno.test("US-2312: malformed JSON resolves to null instead of throwing", async () => {
  const broken = new Response("{not json", {
    headers: { "content-type": "application/json" },
  });
  const parsed = cloneJsonBody(broken);
  assert(parsed !== null);
  assertEquals(await parsed, null);
  // A body we cannot read must still leave a run record.
  assertEquals(readJobOutcome(await parsed).failedItems, 0);
});
