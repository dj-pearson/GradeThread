// The referral routes, driven through Hono against the in-memory PostgREST
// stand-in, so the queries under test are the production ones.
//
//   deno test src/tests/referrals_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { referralRoutes } from "../routes/referrals.ts";
import {
  classifyReferralRows,
  DEFAULT_REFERRAL_REWARD_CONFIG,
  redeemRefusal,
  type ReferralLedgerRow,
} from "../lib/referral-rewards.ts";
import { grantReferralReward } from "../lib/referrals.ts";
import { bustSettingCache } from "../lib/system-settings.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEWBIE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CODE = "ABCD2345";
const DAY = 86_400_000;

function app(userId = NEWBIE) {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  a.route("/", referralRoutes);
  return a;
}

function redeem(body: Record<string, unknown>, userId = NEWBIE) {
  return app(userId).request("/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: CODE, ...body }),
  });
}

function seed(extra: Record<string, Row[]> = {}, newbieAgeDays = 1): Record<string, Row[]> {
  bustSettingCache();
  return {
    system_settings: [],
    users: [
      { id: OWNER, suspended: false, created_at: new Date(Date.now() - 400 * DAY).toISOString() },
      {
        id: NEWBIE,
        suspended: false,
        created_at: new Date(Date.now() - newbieAgeDays * DAY).toISOString(),
      },
    ],
    referral_codes: [{ id: "rc1", user_id: OWNER, code: CODE }],
    referral_events: [],
    grade_credit_transactions: [],
    affiliate_clicks: [],
    notifications: [],
    ...extra,
  };
}

Deno.test("redeem: a 30-day-old account is refused with account_too_old", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({}, 30));
    const res = await redeem({});
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error_code, "account_too_old");
    assertEquals(db.tables.referral_events.length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("redeem: an account that already bought credits is refused", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({
      grade_credit_transactions: [{ id: "t1", user_id: NEWBIE, reason: "pack_purchase", delta: 10 }],
    }));
    const res = await redeem({});
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error_code, "already_paid");
  } finally {
    db.restore();
  }
});

Deno.test("redeem: B redeeming A's code after A redeemed B's is circular", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({
      referral_events: [{
        id: "e0",
        referrer_user_id: NEWBIE,
        referred_user_id: OWNER,
        code: "ZZZZ2345",
        reward_status: "pending",
      }],
    }));
    const res = await redeem({});
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error_code, "circular_referral");
    assertEquals(db.tables.referral_events.length, 1);
  } finally {
    db.restore();
  }
});

Deno.test("redeem: source=affiliate with no click behind it is stored as direct", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed());
    const res = await redeem({ source: "affiliate" });
    assertEquals(res.status, 200);
    const ev = db.tables.referral_events.find((r) => r.referred_user_id === NEWBIE);
    assertEquals(ev?.attribution_source, "direct");
  } finally {
    db.restore();
  }
});

Deno.test("redeem: the visitor's own click_id is stamped, not the newest click", async () => {
  const db = installFakePostgrest();
  const mine = "11111111-1111-4111-8111-111111111111";
  const newer = "22222222-2222-4222-8222-222222222222";
  try {
    db.reset(seed({
      affiliate_clicks: [
        {
          id: mine,
          code: CODE,
          landing_path: "/",
          converted_user_id: null,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          id: newer,
          code: CODE,
          landing_path: "/",
          converted_user_id: null,
          created_at: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
    }));
    const res = await redeem({ source: "affiliate", click_id: mine });
    assertEquals(res.status, 200);
    const clicks = db.tables.affiliate_clicks;
    assertEquals(clicks.find((r) => r.id === mine)?.converted_user_id, NEWBIE);
    assertEquals(clicks.find((r) => r.id === newer)?.converted_user_id, null);
    const ev = db.tables.referral_events.find((r) => r.referred_user_id === NEWBIE);
    assertEquals(ev?.attribution_source, "affiliate");
  } finally {
    db.restore();
  }
});

Deno.test("redeem: with no click_id, no click is stamped at all", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({
      affiliate_clicks: [{
        id: "33333333-3333-4333-8333-333333333333",
        code: CODE,
        landing_path: "/c/GT-123",
        converted_user_id: null,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    }));
    const res = await redeem({ source: "affiliate" });
    assertEquals(res.status, 200);
    assertEquals(db.tables.affiliate_clicks[0].converted_user_id, null);
    // A click on the code exists, so the channel is still affiliate.
    const ev = db.tables.referral_events.find((r) => r.referred_user_id === NEWBIE);
    assertEquals(ev?.attribution_source, "affiliate");
  } finally {
    db.restore();
  }
});

Deno.test("redeemRefusal: a zero window never refuses on age", () => {
  const base = { nowMs: Date.now(), hasPaidPurchase: false, circular: false };
  assertEquals(
    redeemRefusal({ ...base, accountCreatedAt: "2020-01-01T00:00:00Z", windowDays: 0 }),
    null,
  );
  assertEquals(
    redeemRefusal({ ...base, accountCreatedAt: "2020-01-01T00:00:00Z", windowDays: 14 }),
    "account_too_old",
  );
  assertEquals(
    redeemRefusal({ ...base, accountCreatedAt: new Date().toISOString(), windowDays: 14 }),
    null,
  );
});

// ── What /me reports ────────────────────────────────────────────────────────

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

Deno.test("classifyReferralRows: a grant reports what it paid, not today's rate", () => {
  const rows: ReferralLedgerRow[] = [
    { reward_status: "granted", referrer_reward_credits: 5, created_at: iso(10 * DAY), qualified_at: iso(9 * DAY) },
  ];
  const today = { ...DEFAULT_REFERRAL_REWARD_CONFIG, referrer_credits: 3 };
  const s = classifyReferralRows(rows, today, Date.now());
  assertEquals(s.earned, 5);
  assertEquals(s.granted, 1);
});

Deno.test("classifyReferralRows: a capped qualified row is forfeit, not pending", () => {
  const config = { ...DEFAULT_REFERRAL_REWARD_CONFIG, per_referrer_cap: 1 };
  const rows: ReferralLedgerRow[] = [
    { reward_status: "granted", referrer_reward_credits: 5, created_at: iso(10 * DAY), qualified_at: iso(9 * DAY) },
    { reward_status: "qualified", referrer_reward_credits: null, created_at: iso(5 * DAY), qualified_at: iso(4 * DAY) },
    { reward_status: "pending", referrer_reward_credits: null, created_at: iso(1 * DAY), qualified_at: null },
  ];
  const s = classifyReferralRows(rows, config, Date.now(), 10);
  assertEquals(s.forfeit, 1);
  assertEquals(s.waiting, 1);
  assertEquals(s.pending_credits, 5);
  assertEquals(s.earned, 15);
});

Deno.test("classifyReferralRows: past the window, pending and late-qualified rows are forfeit", () => {
  const config = { ...DEFAULT_REFERRAL_REWARD_CONFIG, qualification_window_days: 30 };
  const rows: ReferralLedgerRow[] = [
    { reward_status: "pending", referrer_reward_credits: null, created_at: iso(40 * DAY), qualified_at: null },
    { reward_status: "qualified", referrer_reward_credits: null, created_at: iso(50 * DAY), qualified_at: iso(5 * DAY) },
    { reward_status: "pending", referrer_reward_credits: null, created_at: iso(3 * DAY), qualified_at: null },
  ];
  const s = classifyReferralRows(rows, config, Date.now());
  assertEquals(s.forfeit, 2);
  assertEquals(s.waiting, 1);
});

Deno.test("GET /me: numbers come from the ledger, and the rules come back", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({
      system_settings: [{
        id: "s1",
        key: "referral.reward_config",
        value: { referrer_credits: 3, per_referrer_cap: 1 },
      }],
      referral_events: [
        { id: "e1", referrer_user_id: OWNER, referred_user_id: NEWBIE, reward_status: "granted", referrer_reward_credits: 5, created_at: iso(9 * DAY), qualified_at: iso(8 * DAY) },
        { id: "e2", referrer_user_id: OWNER, referred_user_id: "x", reward_status: "qualified", referrer_reward_credits: null, created_at: iso(5 * DAY), qualified_at: iso(4 * DAY) },
      ],
      referral_milestone_grants: [],
    }));
    const res = await app(OWNER).request("/me");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.code, CODE);
    assertEquals(body.credits, { per_referral: 3, earned: 5, pending: 0 });
    assertEquals(body.stats.forfeit, 1);
    assertEquals(body.stats.waiting, 0);
    assertEquals(body.rules.cap_remaining, 0);
    assertEquals(body.rules.referred_bonus, 3);
    // 400 days old: too old to type in a friend's code.
    assertEquals(body.redeem_eligible, false);
  } finally {
    db.restore();
  }
});

Deno.test("grantReferralReward: a 0-credit side is skipped, the other side still paid", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed({
      system_settings: [{ id: "s1", key: "referral.reward_config", value: { referred_credits: 0 } }],
      referral_events: [{
        id: "e1",
        referrer_user_id: OWNER,
        referred_user_id: NEWBIE,
        reward_status: "qualified",
        created_at: iso(DAY),
        qualified_at: iso(0),
      }],
      referral_milestone_grants: [],
    }));
    const result = await grantReferralReward("e1");
    assertEquals(result.status, "granted");
    const grants = db.calls.filter((c) => c.table === "rpc:grant_grade_credits");
    assertEquals(grants.length, 1);
    assertEquals((grants[0].body as Record<string, unknown>).p_user_id, OWNER);
    assertEquals(db.tables.referral_events[0].reward_status, "granted");
  } finally {
    db.restore();
  }
});

// ── GET /me/events ──────────────────────────────────────────────────────────

Deno.test("GET /me/events: only the caller's referrals, masked, and they add up to /me", async () => {
  const db = installFakePostgrest();
  const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  try {
    db.reset(seed({
      system_settings: [{
        id: "s1",
        key: "referral.reward_config",
        value: { per_referrer_cap: 1, qualification_window_days: 30 },
      }],
      referral_events: [
        { id: "e1", referrer_user_id: OWNER, referred_user_id: NEWBIE, reward_status: "granted", referrer_reward_credits: 5, created_at: iso(20 * DAY), qualified_at: iso(19 * DAY) },
        { id: "e2", referrer_user_id: OWNER, referred_user_id: "x1", reward_status: "qualified", referrer_reward_credits: null, created_at: iso(10 * DAY), qualified_at: iso(9 * DAY) },
        { id: "e3", referrer_user_id: OWNER, referred_user_id: "x2", reward_status: "pending", referrer_reward_credits: null, created_at: iso(2 * DAY), qualified_at: null },
        { id: "e4", referrer_user_id: OWNER, referred_user_id: "x3", reward_status: "pending", referrer_reward_credits: null, created_at: iso(45 * DAY), qualified_at: null },
        // Somebody else's referral: must never show up in OWNER's list.
        { id: "e5", referrer_user_id: OTHER, referred_user_id: "x4", reward_status: "granted", referrer_reward_credits: 5, created_at: iso(3 * DAY), qualified_at: iso(DAY) },
      ],
      referral_milestone_grants: [],
    }));
    const events = (await (await app(OWNER).request("/me/events")).json()).events as Array<
      { label: string; status: string; reason: string | null; credits: number; qualify_by: string | null }
    >;
    assertEquals(events.length, 4);
    assertEquals(events.map((e) => e.label), ["Seller #1", "Seller #2", "Seller #3", "Seller #4"]);
    assertEquals(JSON.stringify(events).includes("x1"), false);

    const me = await (await app(OWNER).request("/me")).json();
    const count = (s: string) => events.filter((e) => e.status === s).length;
    assertEquals(count("rewarded"), me.stats.granted);
    assertEquals(count("waiting"), me.stats.waiting);
    assertEquals(count("forfeit"), me.stats.forfeit);
    assertEquals(events.reduce((a, e) => a + e.credits, 0), me.credits.earned);
    const reasons = events.filter((e) => e.status === "forfeit").map((e) => e.reason).sort();
    assertEquals(reasons, ["expired", "over_cap"]);

    const other = (await (await app(OTHER).request("/me/events")).json()).events;
    assertEquals(other.length, 1);
  } finally {
    db.restore();
  }
});

Deno.test("GET /me: leaderboard rank is null with no rewarded referral, and the board's rank after one", async () => {
  const db = installFakePostgrest();
  try {
    const base = seed();
    base.users[0] = { ...base.users[0], referral_leaderboard_enabled: true, referral_display_name: "ThriftKing" };
    db.reset(base);
    let me = await (await app(OWNER).request("/me")).json();
    assertEquals(me.leaderboard.rank, null);

    base.referral_events = [{
      id: "e1",
      referrer_user_id: OWNER,
      referred_user_id: NEWBIE,
      reward_status: "granted",
      referrer_reward_credits: 5,
      created_at: iso(3 * DAY),
      qualified_at: iso(2 * DAY),
    }];
    db.reset(base);
    me = await (await app(OWNER).request("/me")).json();
    assertEquals(me.leaderboard.rank, 1);
    assertEquals(me.leaderboard.tied, false);
  } finally {
    db.restore();
  }
});
