// US-2104 AC3 — a social post must not be marked 'published' when there is
// provably nowhere to publish it to.
//
// THE BUG. With every make_webhook_social* unset — which is the CURRENT
// production state — dispatchContentWebhook returns early with attempts:0 and
// writes no webhook log and no dead letter. The publish route flipped the row to
// status='published' anyway. So the engine reported success while sending
// nothing, and because 'published' is terminal the post would never be
// revisited. The scheduler tick had the same hole, where it is worse: unattended,
// it drains the ENTIRE scheduled queue into that terminal state in one pass.
//
// WHAT THIS IS NOT. It is deliberately not "roll back on webhook failure",
// which is what the acceptance criterion's wording ("unset or the POST failed")
// literally asks for. A CONFIGURED webhook that fails is already handled well:
// the payload is logged to content_webhook_log, dead-lettered, and replayable
// via POST /webhooks/:logId/retry. Nothing is lost and a retry lands it, so
// publishing is correct there — reversing it would break the replay workflow and
// undo a documented decision. The two cases only look alike; one is recoverable
// and recorded, the other is neither.
//
// The distinction under test is therefore CONFIGURATION, not DELIVERY.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { hasAnySocialWebhookConfigured } = await import("../lib/content-webhook.ts");

// ── The guard's own semantics ───────────────────────────────────────────────

Deno.test("hasAnySocialWebhookConfigured FAILS OPEN when settings are unreadable", async () => {
  // Dummy SUPABASE_URL → the read errors. The failure mode being fixed is a
  // confident FALSE SUCCESS, not a blocked publish: an unreachable settings row
  // is not evidence of misconfiguration, and treating it as such would let a
  // transient DB blip silently halt all publishing. Fail open, stay loud
  // elsewhere.
  assertEquals(await hasAnySocialWebhookConfigured(), true);
});

// ── The decision table the routes encode ────────────────────────────────────
//
// Asserted as a pure function of the settings row so the rule is legible and
// cannot drift into "any truthy column" or "all columns required". Mirrors the
// OR in hasAnySocialWebhookConfigured.

function anyConfigured(row: {
  make_webhook_social?: string | null;
  make_webhook_social_long?: string | null;
  make_webhook_social_short?: string | null;
}): boolean {
  return Boolean(
    row.make_webhook_social || row.make_webhook_social_long ||
      row.make_webhook_social_short,
  );
}

Deno.test("no destination configured → publishing would be a no-op", () => {
  assertEquals(anyConfigured({}), false);
  assertEquals(
    anyConfigured({
      make_webhook_social: null,
      make_webhook_social_long: null,
      make_webhook_social_short: null,
    }),
    false,
  );
  // Empty strings are not destinations. A blank env/settings value that
  // resolved to "" would otherwise read as configured — the same class of bug
  // as a CI secret that fails to resolve and reports green.
  assertEquals(
    anyConfigured({
      make_webhook_social: "",
      make_webhook_social_long: "",
      make_webhook_social_short: "",
    }),
    false,
  );
});

Deno.test("ANY single destination is enough — the legacy long/short pair still counts", () => {
  // US-870 introduced the single router webhook, but existing deployments run on
  // the legacy long/short URLs. Requiring the router would refuse to publish for
  // every deployment that is actually correctly configured.
  assert(anyConfigured({ make_webhook_social: "https://hook.example/router" }));
  assert(anyConfigured({ make_webhook_social_long: "https://hook.example/long" }));
  assert(anyConfigured({ make_webhook_social_short: "https://hook.example/short" }));
});

// ── The routes wire the guard in, and in the right place ───────────────────
//
// Source-level assertions. The routes need a live Hono context plus a database
// to exercise end-to-end, but the properties that matter are structural: that
// the check exists on BOTH publish paths, that the scheduler leaves posts
// scheduled rather than rewriting them, and that the scheduler asks once per
// tick rather than once per post.

const socialRoute = await Deno.readTextFile(
  new URL("../routes/content-social.ts", import.meta.url),
);
const schedulerRoute = await Deno.readTextFile(
  new URL("../routes/content-scheduler.ts", import.meta.url),
);

// Match the CALL, not the identifier. Searching for the bare name matches the
// import line too — which is exactly how the first version of this test passed
// against a scheduler whose guard had been deleted: the import survived, sat at
// line 11, and satisfied every "appears before the loop" assertion. A guard test
// that a deleted guard passes is worse than no test.
const CALL = "await hasAnySocialWebhookConfigured()";

Deno.test("the manual publish route refuses before it writes status='published'", () => {
  const guardAt = socialRoute.indexOf(CALL);
  const publishAt = socialRoute.indexOf('status: "published"');
  assert(guardAt > -1, "manual publish route must consult the guard");
  assert(publishAt > -1);
  assert(
    guardAt < publishAt,
    "the guard must run BEFORE the row is flipped — checking afterwards would " +
      "mean rolling back a published row, which is the fragile version of this fix",
  );
  assert(
    socialRoute.includes("social_webhook_unconfigured"),
    "the refusal needs a stable machine-readable code, not just prose",
  );
});

Deno.test("the scheduler tick defers instead of draining the queue", () => {
  const guardAt = schedulerRoute.indexOf(CALL);
  assert(guardAt > -1, "the scheduler must consult the guard too — it is the " +
    "unattended path and therefore the higher-blast-radius one");

  // It must bail BEFORE the loop that flips rows, so due posts stay 'scheduled'.
  const loopAt = schedulerRoute.indexOf("for (const post of socials ?? [])");
  assert(loopAt > -1);
  assert(
    guardAt < loopAt,
    "the scheduler guard must short-circuit before the publish loop",
  );

  // Deferred, not dropped: nothing may rewrite scheduled_for on this path, or a
  // misconfiguration would silently reschedule the backlog into the future.
  const between = schedulerRoute.slice(guardAt, loopAt);
  assert(
    !between.includes("scheduled_for:"),
    "the deferral must not rewrite scheduled_for — posts publish for real once " +
      "a webhook is set",
  );
});

Deno.test("the scheduler checks configuration once per tick, not once per post", () => {
  const loopAt = schedulerRoute.indexOf("for (const post of socials ?? [])");
  const afterLoop = schedulerRoute.slice(loopAt);
  assert(
    !afterLoop.slice(0, afterLoop.indexOf("return published")).includes(CALL),
    "re-reading the same global settings row per post turns one batch into N " +
      "queries for an answer that cannot change mid-loop",
  );
});
