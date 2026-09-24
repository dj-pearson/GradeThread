// R5: every cohort-sized `.in(...)` on a board read is chunked.
//
// The cohort is up to COHORT_MAX ids, and one `.in()` over all of them is a URL
// the proxy refuses with a 414, which each board used to turn silently into
// "Not ranked yet" for everybody. Driven through the real supabase-js client
// against the in-memory PostgREST so the assertion is on the URLs actually sent.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest } from "./_fake-postgrest.ts";
import { type CohortMember, loadBoard } from "../lib/leaderboards-data.ts";
import { chunk, COHORT_IN_CHUNK, LEADERBOARD_METRICS } from "../lib/leaderboards.ts";

function inListLengths(params: URLSearchParams): number[] {
  const out: number[] = [];
  for (const [, v] of params.entries()) {
    const m = /^in\.\((.*)\)$/.exec(v);
    if (m) out.push(m[1].split(",").length);
  }
  return out;
}

const COHORT: CohortMember[] = Array.from({ length: 1000 }, (_, i) => ({
  userId: crypto.randomUUID(),
  alias: `Seller ${i}`,
  handle: i % 2 === 0 ? `seller-${i}` : null,
  since: "2026-01-01T00:00:00.000Z",
}));

Deno.test("R5: chunk splits into consecutive bounded slices", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 200), []);
  assert(COHORT_IN_CHUNK * 37 < 8000, "a chunk of quoted UUIDs stays well under the 414 limit");
});

Deno.test("R5: no board read sends more than COHORT_IN_CHUNK ids in one .in()", async () => {
  const db = installFakePostgrest();
  try {
    const at = "2026-09-22T12:00:00.000Z";
    const reportId = crypto.randomUUID();
    db.reset({
      user_reward_state: COHORT.slice(0, 300).map((m, i) => ({
        user_id: m.userId,
        xp_peak: 100 + i,
        xp_total: 100 + i,
        level: 2,
      })),
      reputation_events: [{
        user_id: COHORT[900].userId,
        event_type: "coverage_completed",
        verified: true,
        metadata: { paid: true },
        occurred_at: at,
      }],
      referral_events: [{
        referrer_user_id: COHORT[950].userId,
        reward_status: "granted",
        granted_at: at,
      }],
      public_showcase_finds: [{
        grade_report_id: reportId,
        showcased_at: at,
        brand: "Levi's",
        brand_slug: "levis",
        category: "denim",
        seller_handle: "seller-998",
      }],
      showcase_reactions: [{ grade_report_id: reportId, user_id: COHORT[1].userId }],
      grade_reports: [],
      submissions: [],
    });
    const weekly = {
      period: "weekly" as const,
      startMs: Date.parse("2026-09-21T00:00:00.000Z"),
      endMs: Date.parse("2026-09-28T00:00:00.000Z"),
    };
    const allTime = { period: "all_time" as const, startMs: null, endMs: null };
    const none = { brandSlug: null, category: null };

    for (const w of [allTime, weekly]) {
      for (const m of LEADERBOARD_METRICS) await loadBoard(m.key, COHORT, w, none);
    }

    const reads = db.calls.filter((c) => c.method === "GET");
    assert(reads.length > 0);
    for (const call of reads) {
      for (const n of inListLengths(call.params)) {
        assert(n <= COHORT_IN_CHUNK && n <= 200, `${call.table} got an .in() of ${n} ids`);
      }
    }

    // Chunking must not cost anyone their score: a seller past the first chunk
    // is still counted on every board.
    const xpAll = await loadBoard("xp", COHORT, allTime, none);
    assertEquals(xpAll.candidates.find((c) => c.userId === COHORT[299].userId)?.score, 399);
    const xpWeek = await loadBoard("xp", COHORT, weekly, none);
    assert((xpWeek.candidates.find((c) => c.userId === COHORT[900].userId)?.score ?? 0) > 0);
    const shares = await loadBoard("shares", COHORT, weekly, none);
    assertEquals(shares.candidates.find((c) => c.userId === COHORT[950].userId)?.score, 1);
    const finds = await loadBoard("finds", COHORT, allTime, none);
    assertEquals(finds.candidates.find((c) => c.userId === COHORT[998].userId)?.score, 1);
  } finally {
    db.restore();
  }
});

Deno.test("R5: the weekly XP scan asks only for scoring event types", async () => {
  const src = await Deno.readTextFile(new URL("../lib/leaderboards-data.ts", import.meta.url));
  assert(src.includes('.in("event_type", REWARD_TYPE_LIST)'));
});
