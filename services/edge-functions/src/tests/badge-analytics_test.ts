// US-1760: the pure aggregation + guards of the badge funnel. The DB-backed
// record/funnel fns need a live stack; the source gating + by-source aggregation
// are pure and tested here.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { aggregateClicksBySource, isBadgeTargetType, BADGE_CLICK_SOURCES } = await import(
  "../lib/badge-analytics.ts"
);

Deno.test("aggregateClicksBySource: counts per source + total", () => {
  const rows = [
    { source: "embed" },
    { source: "embed" },
    { source: "qr" },
    { source: "badge" },
  ];
  const out = aggregateClicksBySource(rows);
  assertEquals(out.totalClicks, 4);
  assertEquals(out.clicksBySource, { embed: 2, qr: 1, badge: 1 });
});

Deno.test("aggregateClicksBySource: empty input → zeroed", () => {
  assertEquals(aggregateClicksBySource([]), { clicksBySource: {}, totalClicks: 0 });
});

Deno.test("isBadgeTargetType guards cert/seller only", () => {
  assert(isBadgeTargetType("cert"));
  assert(isBadgeTargetType("seller"));
  assert(!isBadgeTargetType("listing"));
  assert(!isBadgeTargetType(null));
});

Deno.test("BADGE_CLICK_SOURCES: attributed click-throughs only, never direct", () => {
  assert(BADGE_CLICK_SOURCES.has("embed"));
  assert(BADGE_CLICK_SOURCES.has("badge"));
  assert(BADGE_CLICK_SOURCES.has("qr"));
  // US-1854: `share` joined the set. It answers the SAME question as the three
  // above — did a real person come back to this grade because of it — so it
  // rides the same ledger. `direct` still must not: an unattributed visit is
  // not a click-through, and admitting it would make every funnel number the
  // page-view count.
  assert(BADGE_CLICK_SOURCES.has("share"));
  assert(!BADGE_CLICK_SOURCES.has("direct"));
  assert(!BADGE_CLICK_SOURCES.has(""));
});
