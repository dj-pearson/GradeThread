// US-3198 AC4: the stale-extension-queue push.
//
// The decision module is pure, so the arithmetic is tested directly. The route
// and the delivery seam are read from source, because what matters about them is
// a set of properties a mock would let you fake: that the push is gated on a
// preference and on quiet hours, that the cron takes the job secret and a lock,
// and that every queue read is scoped to one seller.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

import {
  DRAIN_SILENCE_HOURS,
  EXTENSION_QUEUE_PREF_KEY,
  NOTICE_WINDOW_HOURS,
  shouldNotifyStaleQueue,
  STALE_QUEUE_LINK,
  STALE_QUEUE_THRESHOLD,
  staleQueueNotice,
} from "../lib/extension-queue-stale.ts";

const NOW = new Date("2026-09-11T17:00:00Z");
const HOUR = 3_600_000;

/** A drain `hours` before NOW. */
function drainedHoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function verdict(over: Partial<Parameters<typeof shouldNotifyStaleQueue>[0]> = {}) {
  return shouldNotifyStaleQueue({
    pendingCount: STALE_QUEUE_THRESHOLD,
    lastDrainedAt: drainedHoursAgo(30),
    recentDelistNotice: false,
    now: NOW,
    ...over,
  });
}

// -- The threshold ----------------------------------------------------

Deno.test("US-3198: the threshold is one more than a single garment can produce", () => {
  // Pinned so a change is a visible diff rather than a silent product decision.
  // Five extension channels (poshmark, mercari, grailed, vinted, facebook), so
  // six is the smallest count that needs two garments.
  assertEquals(STALE_QUEUE_THRESHOLD, 6);
});

Deno.test("US-3198: a single garment's worth of queued work is not a backlog", () => {
  assertEquals(
    verdict({ pendingCount: STALE_QUEUE_THRESHOLD - 1 }),
    { notify: false, reason: "below_threshold" },
  );
});

Deno.test("US-3198: at the threshold, a stale queue notifies", () => {
  assertEquals(verdict(), { notify: true, pendingCount: STALE_QUEUE_THRESHOLD });
});

// -- The window -------------------------------------------------------

Deno.test("US-3198: a drain inside the window silences the notice", () => {
  // The case that matters most. A seller whose desktop ran an hour ago is not
  // stranded, however much is queued behind it.
  assertEquals(
    verdict({ lastDrainedAt: drainedHoursAgo(1), pendingCount: 50 }),
    { notify: false, reason: "drained_recently" },
  );
  // And right up to the boundary.
  assertEquals(
    verdict({ lastDrainedAt: drainedHoursAgo(DRAIN_SILENCE_HOURS - 0.01) }),
    { notify: false, reason: "drained_recently" },
  );
});

Deno.test("US-3198: the notice fires once per spell of silence, not once a day", () => {
  // The repeat suppression IS the window, because there is no per-seller
  // "last notified" state to write. Exactly one daily run lands in [24h, 48h).
  const inWindow = DRAIN_SILENCE_HOURS + NOTICE_WINDOW_HOURS / 2;
  assert(verdict({ lastDrainedAt: drainedHoursAgo(inWindow) }).notify);

  const pastWindow = DRAIN_SILENCE_HOURS + NOTICE_WINDOW_HOURS;
  assertEquals(
    verdict({ lastDrainedAt: drainedHoursAgo(pastWindow) }),
    { notify: false, reason: "already_told" },
  );
  // Five days of silence is still silence, not five notices.
  assertEquals(
    verdict({ lastDrainedAt: drainedHoursAgo(120) }),
    { notify: false, reason: "already_told" },
  );
});

Deno.test("US-3198: the window is exactly one cron period wide", () => {
  // If these two drift apart the suppression breaks in one of two ways, and
  // neither is visible from a passing suite: a wider window buzzes every run, a
  // narrower one lets most sellers fall through the gap.
  assertEquals(NOTICE_WINDOW_HOURS, 24);
});

// -- Never drained ----------------------------------------------------

Deno.test("US-3198: a seller whose extension has NEVER drained is never told their queue is stale", () => {
  // AC2 drew this line on screen ("Your extension has never run any of this")
  // and this is the same line in the notification layer. Telling somebody who
  // has never installed the extension that their queue is stale names a machine
  // they do not have and asks for a fix they cannot perform.
  assertEquals(
    verdict({ lastDrainedAt: null, pendingCount: 200 }),
    { notify: false, reason: "never_drained" },
  );
});

Deno.test("US-3198: an unreadable drain timestamp reads as never-drained, not as stale", () => {
  assertEquals(
    verdict({ lastDrainedAt: "not-a-timestamp" }),
    { notify: false, reason: "never_drained" },
  );
});

// -- Collision with US-3144 -------------------------------------------

Deno.test("US-3198: a delist_needed notice inside the window wins", () => {
  assertEquals(
    verdict({ recentDelistNotice: true }),
    { notify: false, reason: "told_by_delist_notice" },
  );
});

// -- The copy (AC5) ---------------------------------------------------

Deno.test("US-3198 AC5: the notice never claims the queued work happened", () => {
  const notice = staleQueueNotice(7);
  assertStringIncludes(notice.title, "7 queued jobs are waiting");
  assertStringIncludes(notice.body, "Nothing has run yet");
  const all = `${notice.title} ${notice.body}`.toLowerCase();
  for (const claim of ["listed", "posted", "delisted", "ended", "completed", "done"]) {
    assert(
      !all.includes(claim),
      `the stale-queue notice says "${claim}", which reads as work that happened: ${all}`,
    );
  }
});

Deno.test("US-3198: the notice blames neither the seller nor GradeThread", () => {
  const all = `${staleQueueNotice(9).title} ${staleQueueNotice(9).body}`.toLowerCase();
  // Neither is known. The usual cause is a shut laptop, and either accusation
  // sends a working seller somewhere useless (support, or a reinstall).
  for (const blame of ["you have not", "you did not", "you forgot", "failed", "error", "problem"]) {
    assert(!all.includes(blame), `the stale-queue notice blames somebody: "${blame}" in ${all}`);
  }
});

Deno.test("US-3198: the notice links to the queue tray, not the dashboard root", () => {
  assertEquals(staleQueueNotice(6).url, STALE_QUEUE_LINK);
  assertEquals(STALE_QUEUE_LINK, "/dashboard/flipdesk/marketplaces");
});

// -- The route and the delivery seam ----------------------------------

const ROUTE = await Deno.readTextFile(
  new URL("../routes/jobs-extension-queue-stale.ts", import.meta.url),
);
const NOTIFY = await Deno.readTextFile(new URL("../lib/notify.ts", import.meta.url));

Deno.test("US-3198: the cron gates on the job secret and takes a lock", () => {
  assertStringIncludes(ROUTE, "requireJobSecret");
  assertStringIncludes(ROUTE, 'acquireJobLock("extension-queue-stale"');
});

Deno.test("US-268: every per-seller read in the cron is scoped to that seller", () => {
  // The sweep takes no ids from a request, so the boundary is that each
  // follow-up read filters on the user_id the queue row itself carried.
  const drain = ROUTE.slice(ROUTE.indexOf("async function lastDrainedAt"));
  assertStringIncludes(drain.slice(0, 600), '.eq("user_id", userId)');
  assertStringIncludes(ROUTE, '.in("user_id", candidates.map((cand) => cand.userId))');
});

Deno.test("US-3198 AC4: the push is gated on the preference AND on quiet hours", () => {
  const fn = NOTIFY.slice(NOTIFY.indexOf("export async function deliverPreferencePush"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assertStringIncludes(body, "pushChannelEnabled");
  assertStringIncludes(body, "quietHoursActive");
  // Both gates must RETURN, not merely be computed. A gate whose result is
  // discarded is the shape that reads as enforcement and is not.
  assert(
    /if \(!pushChannelEnabled\([^)]*\)\) return false;/.test(body),
    "deliverPreferencePush computes the preference gate without returning on it",
  );
  assert(
    /quietHoursActive\([\s\S]{0,120}\)\s*\)\s*\{\s*return false;/.test(body),
    "deliverPreferencePush computes quiet hours without returning on it",
  );
});

Deno.test("US-3198: the cron uses the same preference key the settings screen renders", () => {
  assertStringIncludes(ROUTE, "EXTENSION_QUEUE_PREF_KEY");
  assertEquals(EXTENSION_QUEUE_PREF_KEY, "extension_queue_reminders");
});

Deno.test("US-3198: the cron does not also send an extension wake", () => {
  // notify.ts already pushes in the other direction to WAKE a drain, on enqueue.
  // A wake sent here would reach a browser that is shut (or it would have
  // drained), and a wake that finds nothing is the one way that path becomes
  // noise. See cross-listings.ts for where the wake belongs.
  assert(
    !ROUTE.includes("deliverExtensionWake"),
    "the stale-queue cron sends an extension wake; the wake belongs at enqueue",
  );
});
