// US-1760: the pure aggregation + guards of the badge funnel. The DB-backed
// record/funnel fns need a live stack; the source gating + by-source aggregation
// are pure and tested here.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest } from "./_fake-postgrest.ts";

const db = installFakePostgrest();

const {
  aggregateClicksBySource,
  isBadgeTargetType,
  BADGE_CLICK_SOURCES,
  recordBadgeClick,
} = await import("../lib/badge-analytics.ts");

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

// ── V6: canonical handles, and no reward without a real visitor ───────────────

const SELLER = "11111111-1111-4111-8111-111111111111";
const CERT = "22222222-2222-4222-8222-222222222222";
const REAL_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function seed() {
  db.reset({
    users: [{ id: SELLER, verified_handle: "myhandle", verified_enabled: true }],
    submissions: [{ id: "sub-1", user_id: SELLER }],
    grade_reports: [{ id: "gr-1", submission_id: "sub-1", certificate_id: CERT }],
    badge_click_events: [],
    share_events: [],
  });
}

/** The reward dedupe keys looked up for this run (grantReward's first read). */
function rewardKeys(): string[] {
  return db.calls
    .filter((c) =>
      c.table === "reputation_events" && c.method === "GET" && c.params.has("reference_id")
    )
    .map((c) => (c.params.get("reference_id") ?? "").replace(/^eq\./, ""));
}

function storedTargets(): unknown[] {
  return (db.tables.badge_click_events ?? []).map((r) => r.target_id);
}

Deno.test("V6: case variants of a handle are one badge, one stored id, one reward key", async () => {
  seed();
  const a = await recordBadgeClick({
    targetType: "seller",
    targetId: "MyHandle",
    source: "embed",
    visitorHash: "v1",
    userAgent: REAL_UA,
  });
  const b = await recordBadgeClick({
    targetType: "seller",
    targetId: "myhandle",
    source: "embed",
    visitorHash: "v2",
    userAgent: REAL_UA,
  });
  assert(a.recorded && b.recorded);
  assertEquals(storedTargets(), ["myhandle", "myhandle"]);
  const keys = rewardKeys();
  assert(keys.length > 0, "the reward path never ran");
  assertEquals(new Set(keys), new Set(["seller:myhandle:embed"]));
});

Deno.test("V6: wildcard and malformed handles are refused before any lookup", async () => {
  for (const bad of ["myhandl_", "my%", "a", "-bad-"]) {
    seed();
    const out = await recordBadgeClick({
      targetType: "seller",
      targetId: bad,
      source: "embed",
      visitorHash: "v1",
      userAgent: REAL_UA,
    });
    assertEquals(out.recorded, false, bad);
    assertEquals(db.calls.filter((c) => c.table === "users").length, 0, bad);
  }
});

Deno.test("V6: an embed click with no visitor fingerprint is recorded but earns nothing", async () => {
  seed();
  const out = await recordBadgeClick({
    targetType: "cert",
    targetId: CERT,
    source: "embed",
    visitorHash: null,
    userAgent: REAL_UA,
  });
  assertEquals(out.recorded, true);
  assertEquals(storedTargets(), [CERT]);
  assertEquals(rewardKeys(), []);
});

Deno.test("V6: the seller's own click on an embed badge is recorded, not rewarded", async () => {
  seed();
  db.tables.share_events = [{
    id: "se-1",
    owner_user_id: SELLER,
    target_type: "cert",
    target_id: CERT,
    sharer_hash: "seller-hash",
  }];
  const out = await recordBadgeClick({
    targetType: "cert",
    targetId: CERT,
    source: "badge",
    visitorHash: "seller-hash",
    userAgent: REAL_UA,
  });
  assertEquals(out.recorded, true);
  assertEquals(db.tables.badge_click_events[0].self_click, true);
  assertEquals(rewardKeys(), []);
});

Deno.test("V6: a bot user agent on a qr click records nothing", async () => {
  seed();
  const out = await recordBadgeClick({
    targetType: "cert",
    targetId: CERT,
    source: "qr",
    visitorHash: "v1",
    userAgent: "facebookexternalhit/1.1",
  });
  assertEquals(out.recorded, false);
  assertEquals(storedTargets(), []);
});
