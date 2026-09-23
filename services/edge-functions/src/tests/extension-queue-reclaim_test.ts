// Stale-claim reclaim for the extension work queue.
//
// Before this, a `claimed` row whose browser died mid-job sat claimed until
// expires_at, seven days out, because /claim reads only `queued`. For a
// sold-elsewhere delist that is a live sibling listing for a week.
//
// The decisions are pure and tested directly. The DB half is read from source,
// because what matters there is a set of properties a mock would let you fake:
// tenant scope, the compare-and-set, no `.or()` on a mutation, and that /claim
// reclaims BEFORE it reads.

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  CLAIM_TTL_MS,
  claimTtlMs,
  decideQueueCompletion,
  DEFAULT_CLAIM_TTL_MS,
  MAX_STALE_CLAIMS,
  MIN_CLAIM_TTL_MS,
  planStaleClaimReclaim,
  STALE_CLAIM_ERROR,
} from "../lib/extension-queue-reclaim.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

Deno.test("reclaim: a delist claimed 16 minutes ago goes back to the queue", () => {
  const plan = planStaleClaimReclaim(
    [{ id: "a", kind: "delist", attempts: 0, claimed_at: ago(16 * MIN) }],
    NOW,
  );
  assertEquals(plan, [
    { id: "a", claimed_at: ago(16 * MIN), action: "requeue", attempts: 1 },
  ]);
});

Deno.test("reclaim: a claim inside its kind's TTL is left alone", () => {
  const plan = planStaleClaimReclaim(
    [
      { id: "d", kind: "delist", attempts: 0, claimed_at: ago(14 * MIN) },
      // A list job gets the long window: re-running a filled form is a
      // duplicate listing, so 30 minutes is still live.
      { id: "l", kind: "list", attempts: 0, claimed_at: ago(30 * MIN) },
      { id: "x", kind: "someday", attempts: 0, claimed_at: ago(45 * MIN) },
    ],
    NOW,
  );
  assertEquals(plan, []);
});

Deno.test("reclaim: every TTL outlasts the extension's own worst case for one job", () => {
  // job timeout 120 s + login-wall grace 5 min + seller-wait grace 3 min
  // (extension-unified/lister/job-store.js). A live job must never look stale.
  const worstCase = 120_000 + 5 * MIN + 3 * MIN;
  for (const [kind, ttl] of Object.entries(CLAIM_TTL_MS)) {
    assert(ttl > worstCase, `${kind} TTL ${ttl} must exceed ${worstCase}`);
  }
  assertEquals(MIN_CLAIM_TTL_MS, 15 * MIN);
  assertEquals(claimTtlMs("unknown-kind"), DEFAULT_CLAIM_TTL_MS);
  assert(DEFAULT_CLAIM_TTL_MS >= Math.max(...Object.values(CLAIM_TTL_MS)));
});

Deno.test("reclaim: the third stale claim fails the row terminally", () => {
  const plan = planStaleClaimReclaim(
    [
      { id: "second", kind: "delist", attempts: 1, claimed_at: ago(20 * MIN) },
      { id: "third", kind: "delist", attempts: MAX_STALE_CLAIMS - 1, claimed_at: ago(20 * MIN) },
      { id: "null", kind: "delist", attempts: null, claimed_at: ago(20 * MIN) },
    ],
    NOW,
  );
  assertEquals(plan.map((p) => [p.id, p.action, p.attempts]), [
    ["second", "requeue", 2],
    ["third", "fail", MAX_STALE_CLAIMS],
    ["null", "requeue", 1],
  ]);
  assertEquals(MAX_STALE_CLAIMS, 3);
  // The delist log shows result.error verbatim for a dead row.
  assertMatch(STALE_CLAIM_ERROR, /stopped retrying/);
});

Deno.test("reclaim: a row with no or garbage claimed_at is not guessed at", () => {
  const plan = planStaleClaimReclaim(
    [
      { id: "n", kind: "delist", attempts: 0, claimed_at: null },
      { id: "g", kind: "delist", attempts: 0, claimed_at: "not a date" },
    ],
    NOW,
  );
  assertEquals(plan, []);
});

Deno.test("complete: a done row is final, whatever arrives later", () => {
  const done = { status: "done", claimed_by: "A" };
  assertEquals(decideQueueCompletion(done, { ok: true, installId: "A" }), "ignore");
  assertEquals(decideQueueCompletion(done, { ok: false, installId: "A" }), "ignore");
});

Deno.test("complete: a success from the original browser lands on a requeued row", () => {
  // The browser went quiet, the row was requeued, then its result arrived.
  // The delist happened; running it again would be the waste.
  assertEquals(
    decideQueueCompletion({ status: "queued", claimed_by: null }, { ok: true, installId: "A" }),
    "apply",
  );
  assertEquals(
    decideQueueCompletion({ status: "claimed", claimed_by: "B" }, { ok: true, installId: "A" }),
    "apply",
  );
});

Deno.test("complete: a stale failure does not cancel the retry a reclaim scheduled", () => {
  assertEquals(
    decideQueueCompletion({ status: "queued", claimed_by: null }, { ok: false, installId: "A" }),
    "ignore",
  );
  assertEquals(
    decideQueueCompletion({ status: "claimed", claimed_by: "B" }, { ok: false, installId: "A" }),
    "ignore",
  );
});

Deno.test("complete: the holder's own failure, or an unlabelled one, still records", () => {
  assertEquals(
    decideQueueCompletion({ status: "claimed", claimed_by: "A" }, { ok: false, installId: "A" }),
    "apply",
  );
  // Today's extension sends no installId on /complete; that must not strand it.
  assertEquals(
    decideQueueCompletion({ status: "claimed", claimed_by: "A" }, { ok: false, installId: null }),
    "apply",
  );
  assertEquals(
    decideQueueCompletion({ status: "claimed", claimed_by: null }, { ok: false, installId: "A" }),
    "apply",
  );
});

// --- the DB half, read from source ------------------------------------------

const ENQUEUE = await Deno.readTextFile(new URL("../lib/extension-enqueue.ts", import.meta.url));
const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-extension-queue.ts", import.meta.url),
);

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert(start >= 0, `could not find ${header}`);
  const next = src.indexOf("\nexport ", start + header.length);
  return src.slice(start, next < 0 ? undefined : next);
}

Deno.test("reclaimStaleClaims: scoped, compare-and-set, and no .or() on the write", () => {
  const body = fnBody(ENQUEUE, "export async function reclaimStaleClaims(");
  const scopes = body.match(/\.eq\("user_id", ownerId\)/g) ?? [];
  assertEquals(scopes.length, 2, "the read AND the write must be tenant-scoped (US-268)");
  assertMatch(body, /\.eq\("status", "claimed"\)\s*\n\s*\.eq\("claimed_at", step\.claimed_at\)/);
  assert(!body.includes(".or("), "no .or() on a mutation (US-1552)");
});

Deno.test("/claim reclaims stale claims before it reads the queue", () => {
  const claim = ROUTE.slice(ROUTE.indexOf('.post("/claim"'));
  const reclaim = claim.indexOf("await reclaimStaleClaims(ownerId");
  const read = claim.indexOf('.eq("status", "queued")');
  assert(reclaim > 0, "/claim must call reclaimStaleClaims");
  assert(reclaim < read, "reclaim must run before the queued read, or the drain misses it");
});

Deno.test("/complete writes only against the status it read", () => {
  const complete = ROUTE.slice(ROUTE.indexOf('.post("/:id/complete"'));
  assert(complete.includes("decideQueueCompletion(row"), "/complete must consult the decision");
  assertMatch(complete, /\.eq\("status", row\.status\)/);
});
