// The cadence gate must not starve the second surface.
//
// THE BUG. The tick picks a surface with:
//
//   if (blogToday < cadence_blog) surface = "blog";
//   else if (socialToday < cadence_social) surface = "social";
//
// and both counts came from posts PUBLISHED today. With auto_publish_blog=false
// the blog tick generates a draft and stops, so nothing is ever published, so
// blogToday is 0 on every tick, so the surface is ALWAYS "blog" and the social
// branch is unreachable. No social post is generated at all — never mind
// auto-published.
//
// That is not an exotic misconfiguration: it is step 4 of the documented
// rollout in vault/40-growth/content-scheduler.md, which says to turn on social
// autopilot FIRST and keep blog manual. The one configuration the runbook asks
// for is the one that silently disables social. It also meant an hourly cron
// authored a blog article — a topic and an AI call — every hour rather than
// once a day.
//
// THE FIX. A cadence slot is consumed by a post the scheduler AUTHORED today,
// whether or not it published. Deduped by id so an auto-published post (authored
// and published in the same tick) still burns exactly one slot — behaviour is
// unchanged once auto-publish is on.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { tallySlots } = await import("../routes/content-scheduler.ts");

type Surface = "blog" | "social";
type Row = { surface: Surface; id: string; product_focus: string };

// The surface pick from POST /tick, extracted verbatim in shape so the test
// exercises the actual decision and not a paraphrase of it.
function pickSurface(
  counts: Map<string, number>,
  cadenceBlog: number,
  cadenceSocial: number,
): Surface | null {
  const blogToday = (counts.get("blog:gradethread") ?? 0) +
    (counts.get("blog:flipdesk") ?? 0) + (counts.get("blog:both") ?? 0);
  const socialToday = (counts.get("social:gradethread") ?? 0) +
    (counts.get("social:flipdesk") ?? 0) + (counts.get("social:both") ?? 0);
  if (blogToday < cadenceBlog) return "blog";
  if (socialToday < cadenceSocial) return "social";
  return null;
}

Deno.test("an unpublished blog draft still consumes today's blog slot", () => {
  // auto_publish_blog=false: the tick authored a blog draft and published
  // nothing. Under the old published-only count this map was empty.
  const counts = tallySlots([
    { surface: "blog", id: "b1", product_focus: "gradethread" },
  ] satisfies Row[]);
  assertEquals(counts.get("blog:gradethread"), 1);
  assertEquals(
    pickSurface(counts, 1, 2),
    "social",
    "with blog cadence met by the draft, the next slot must go to social — " +
      "this is the assertion the starvation bug failed",
  );
});

Deno.test("blog-manual + social-autopilot reaches social on the very next tick", () => {
  // The documented rollout: cadence blog 1/day, social 2/day, blog manual.
  let counts = tallySlots([] satisfies Row[]);
  assertEquals(pickSurface(counts, 1, 2), "blog"); // tick 1 authors a blog draft

  counts = tallySlots([
    { surface: "blog", id: "b1", product_focus: "gradethread" },
  ] satisfies Row[]);
  assertEquals(pickSurface(counts, 1, 2), "social"); // tick 2 — reachable now

  counts = tallySlots([
    { surface: "blog", id: "b1", product_focus: "gradethread" },
    { surface: "social", id: "s1", product_focus: "gradethread" },
  ] satisfies Row[]);
  assertEquals(pickSurface(counts, 1, 2), "social"); // tick 3 — 1 of 2 social

  counts = tallySlots([
    { surface: "blog", id: "b1", product_focus: "gradethread" },
    { surface: "social", id: "s1", product_focus: "gradethread" },
    { surface: "social", id: "s2", product_focus: "flipdesk" },
  ] satisfies Row[]);
  assertEquals(
    pickSurface(counts, 1, 2),
    null,
    "cadence met on both surfaces — the remaining hourly ticks must idle, not " +
      "author a post an hour",
  );
});

Deno.test("an auto-published post burns one slot, not two", () => {
  // Authored and published in the same tick, so it appears in BOTH source
  // queries. Without the id dedup it would consume two slots and halve the
  // effective cadence the moment auto-publish is switched on.
  const counts = tallySlots([
    { surface: "social", id: "s1", product_focus: "gradethread" }, // published
    { surface: "social", id: "s1", product_focus: "gradethread" }, // authored
  ] satisfies Row[]);
  assertEquals(counts.get("social:gradethread"), 1);
});

Deno.test("cadence is summed per surface across products", () => {
  const counts = tallySlots([
    { surface: "social", id: "s1", product_focus: "gradethread" },
    { surface: "social", id: "s2", product_focus: "flipdesk" },
    { surface: "social", id: "s3", product_focus: "both" },
  ] satisfies Row[]);
  assertEquals(counts.get("social:both"), 1);
  assertEquals(
    pickSurface(counts, 0, 3),
    null,
    "three social posts meet a cadence of 3 regardless of how they split " +
      "across product_focus",
  );
});

// ── The AI-creation path must not claim a publish it cannot make ────────────
//
// US-2104 AC3 was wired into the manual publish route and the scheduled-queue
// drain, but not into runSocialTick — the path that runs on every tick.

const schedulerRoute = await Deno.readTextFile(
  new URL("../routes/content-scheduler.ts", import.meta.url),
);

// The tally above is pure, so on its own it cannot tell whether the QUERY
// feeding it still filters on published_at only — revert the query and every
// assertion above stays green. This one closes that hole.
Deno.test("the daily-slot count actually reads authored posts, not just published ones", () => {
  const fnAt = schedulerRoute.indexOf("async function slotsUsedTodayCounts");
  assertEquals(fnAt > -1, true, "the slot counter must exist");
  const body = schedulerRoute.slice(
    fnAt,
    schedulerRoute.indexOf("export function tallySlots"),
  );
  assertEquals(
    body.includes('.gte("created_at", isoSince)'),
    true,
    "counting only published_at is the starvation bug: with auto-publish off " +
      "nothing is ever published and the first surface takes every slot",
  );
  assertEquals(
    body.includes('.eq("generated_by", "ai")'),
    true,
    "the authored branch is the scheduler's own output — a human's draft must " +
      "not silently consume the autopilot's slot",
  );
  assertEquals(
    body.includes('.neq("status", "failed")'),
    true,
    "a failed generation produced nothing, so its slot is still open",
  );
});

Deno.test("runSocialTick consults the webhook guard before publishing", () => {
  const tickAt = schedulerRoute.indexOf("async function runSocialTick");
  assertEquals(tickAt > -1, true);
  const body = schedulerRoute.slice(tickAt);
  const guardAt = body.indexOf("await hasAnySocialWebhookConfigured()");
  const publishAt = body.indexOf('status: "published"');
  assertEquals(
    guardAt > -1,
    true,
    "the AI-creation path is unattended and runs every tick — it needs the " +
      "guard at least as much as the manual route does",
  );
  assertEquals(
    guardAt < publishAt,
    true,
    "the guard must run before the row is flipped, so there is never a " +
      "published row to un-publish",
  );
});
