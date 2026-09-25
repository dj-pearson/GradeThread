// The referral routes, driven through Hono against the in-memory PostgREST
// stand-in, so the queries under test are the production ones.
//
//   deno test src/tests/referrals_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { referralRoutes } from "../routes/referrals.ts";
import { redeemRefusal } from "../lib/referral-rewards.ts";
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
