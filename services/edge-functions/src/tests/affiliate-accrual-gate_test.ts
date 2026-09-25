// The flat affiliate bounty is paid only for a GRANTED referral and only under
// the flat commission model. Driven through the real supabase-js client against
// the in-memory PostgREST stand-in, so the queries are the production ones.
//
//   deno test src/tests/affiliate-accrual-gate_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { accrueAffiliateCommission } from "../lib/affiliate-payout.ts";
import { shouldAccrueAfterGrant } from "../lib/referrals.ts";
import { bustSettingCache } from "../lib/system-settings.ts";

const CREATOR = "11111111-1111-1111-1111-111111111111";
const FRIEND = "22222222-2222-2222-2222-222222222222";
const EVENT = "33333333-3333-3333-3333-333333333333";

// model null = the engine switched on but no model chosen, so the default
// (subscription_pct) applies.
function seed(rewardStatus: string, model: "flat" | null): Record<string, Row[]> {
  bustSettingCache();
  const value: Row = { mode: "batched", commission_per_conversion: 5 };
  if (model) value.commission_model = model;
  const settings: Row[] = [{ id: "s1", key: "affiliate_payout_config", value }];
  return {
    system_settings: settings,
    affiliate_accounts: [{ id: "a1", user_id: CREATOR, program: "creator" }],
    referral_events: [{
      id: EVENT,
      referrer_user_id: CREATOR,
      referred_user_id: FRIEND,
      attribution_source: "affiliate",
      reward_status: rewardStatus,
    }],
    affiliate_commissions: [],
  };
}

Deno.test("accrual: a qualified but never granted referral earns no cash", async () => {
  const db = installFakePostgrest();
  try {
    for (const status of ["qualified", "pending"]) {
      db.reset(seed(status, "flat"));
      const res = await accrueAffiliateCommission(EVENT);
      assertEquals(res, { accrued: false, reason: "not_granted" });
      assertEquals(db.writes("affiliate_commissions").length, 0);
    }
  } finally {
    db.restore();
  }
});

Deno.test("accrual: the default (subscription_pct) config writes no flat row", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed("granted", null));
    const res = await accrueAffiliateCommission(EVENT);
    assertEquals(res, { accrued: false, reason: "wrong_model" });
    assertEquals(db.writes("affiliate_commissions").length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("accrual: a granted creator referral under the flat model accrues one flat row", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(seed("granted", "flat"));
    const res = await accrueAffiliateCommission(EVENT);
    assertEquals(res, { accrued: true, amount: 500 });
    const rows = db.tables.affiliate_commissions;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].commission_model, "flat");
    assertEquals(rows[0].referred_user_id, FRIEND);
    assertEquals(rows[0].affiliate_user_id, CREATOR);
  } finally {
    db.restore();
    bustSettingCache();
  }
});

Deno.test("shouldAccrueAfterGrant: only granted outcomes accrue cash", () => {
  assertEquals(shouldAccrueAfterGrant({ status: "already_granted" }), true);
  for (
    const r of [
      { status: "expired", reason: "x" },
      { status: "capped", reason: "x" },
      { status: "blocked", reason: "x" },
      { status: "error", reason: "x" },
      { status: "not_found" },
    ] as const
  ) {
    assertEquals(shouldAccrueAfterGrant(r), false);
  }
});
