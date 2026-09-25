// The public top-referrers board: chunked reads, alias rules, real credits,
// shared ranks for ties, and a cache header.
//
//   deno test src/tests/referral-leaderboard_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { contentPublicRoutes } from "../routes/content-public.ts";
import { referralRoutes } from "../routes/referrals.ts";
import { rankReferrers, referrerRank, referrerTotals } from "../lib/referral-rewards.ts";

const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

Deno.test("feed: 900 opted-in ids are read in .in() chunks of 200 or fewer", async () => {
  const db = installFakePostgrest();
  try {
    const users: Row[] = Array.from({ length: 900 }, (_, i) => ({
      id: uid(i),
      referral_leaderboard_enabled: true,
      referral_display_name: `Seller ${i}`,
    }));
    db.reset({
      users,
      referral_events: [
        { id: "e1", referrer_user_id: uid(3), reward_status: "granted", referrer_reward_credits: 5 },
        { id: "e2", referrer_user_id: uid(850), reward_status: "granted", referrer_reward_credits: 3 },
      ],
    });
    const res = await contentPublicRoutes.request("/referral-leaderboard.json");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "public, max-age=300");
    const reads = db.calls.filter((c) => c.table === "referral_events" && c.method === "GET");
    assertEquals(reads.length, 5);
    for (const r of reads) {
      const list = (r.params.get("referrer_user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
      assert(list.length <= 200, `an .in() carried ${list.length} ids`);
    }
    const body = await res.json();
    assertEquals(body.referrers.map((r: { credits_earned: number }) => r.credits_earned), [5, 3]);
  } finally {
    db.restore();
  }
});

Deno.test("feed: a stored alias that fails the alias rules is not published", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({
      users: [
        { id: uid(1), referral_leaderboard_enabled: true, referral_display_name: "GradeThread Official" },
        { id: uid(2), referral_leaderboard_enabled: true, referral_display_name: "Evil\u202Eeman" },
        { id: uid(3), referral_leaderboard_enabled: true, referral_display_name: "ThriftKing" },
      ],
      referral_events: [1, 2, 3].map((i) => ({
        id: `e${i}`,
        referrer_user_id: uid(i),
        reward_status: "granted",
        referrer_reward_credits: 5,
      })),
    });
    const body = await (await contentPublicRoutes.request("/referral-leaderboard.json")).json();
    assertEquals(body.referrers.map((r: { display_name: string }) => r.display_name), ["ThriftKing"]);
  } finally {
    db.restore();
  }
});

Deno.test("PUT /leaderboard: a reserved or bidi alias is a 400", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ users: [{ id: uid(1), referral_display_name: null }] });
    // deno-lint-ignore no-explicit-any
    const app = new Hono<any>();
    app.use("*", async (c, next) => {
      c.set("userId", uid(1));
      await next();
    });
    app.route("/", referralRoutes);
    for (const name of ["GradeThread Official", "Evil\u202Eeman"]) {
      const res = await app.request("/leaderboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, display_name: name }),
      });
      assertEquals(res.status, 400, name);
      await res.body?.cancel();
    }
    assertEquals(db.writes("users").length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("rankReferrers: tied sellers share a rank and the next one skips", () => {
  const users = [1, 2, 3].map((i) => ({ id: uid(i), display_name: `S${i}` }));
  const t = referrerTotals([
    { referrer_user_id: uid(1), referrer_reward_credits: 5 },
    { referrer_user_id: uid(2), referrer_reward_credits: 5 },
    { referrer_user_id: uid(3), referrer_reward_credits: 3 },
  ]);
  const board = rankReferrers(users, t);
  assertEquals(board.map((r) => [r.rank, r.tied]), [[1, true], [1, true], [3, false]]);
  assertEquals(referrerRank(users, t, uid(3)), { rank: 3, tied: false });
  assertEquals(referrerRank(users, t, uid(9)), null);
});
