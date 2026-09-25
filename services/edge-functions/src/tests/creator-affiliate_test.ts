// The creator cash routes, driven through Hono against the in-memory PostgREST
// stand-in. No network and no Stripe: every case here is answered before a
// Stripe client would be built, or tests a pure helper the route uses.
//
//   deno test src/tests/creator-affiliate_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import {
  affiliateRoutes,
  isConnectPayoutReady,
  taxProfileProblem,
} from "../routes/affiliate.ts";
import { bustSettingCache } from "../lib/system-settings.ts";

const ME = "11111111-1111-1111-1111-111111111111";

if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  Deno.env.set("EDGE_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
}

function app() {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", ME);
    await next();
  });
  a.route("/", affiliateRoutes);
  return a;
}

function post(path: string, body: unknown) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FULL_TAX = {
  legal_name: "Pat Seller",
  entity_type: "individual",
  tin: "123-45-6789",
  country: "US",
  address_line1: "1 Main St",
  city: "Des Moines",
  region: "IA",
  postal_code: "50309",
  certify: true,
};

function account(row: Partial<Row>): Record<string, Row[]> {
  return { affiliate_accounts: [{ id: "acct", user_id: ME, ...row }], affiliate_tax_profiles: [] };
}

Deno.test("connect readiness: a transfers-only account with charges disabled is ready", () => {
  assertEquals(
    isConnectPayoutReady({
      capabilities: { transfers: "active" },
      payouts_enabled: true,
    }),
    true,
  );
  assertEquals(
    isConnectPayoutReady({ capabilities: { transfers: "pending" }, payouts_enabled: true }),
    false,
  );
  assertEquals(
    isConnectPayoutReady({ capabilities: { transfers: "active" }, payouts_enabled: false }),
    false,
  );
  assertEquals(isConnectPayoutReady({}), false);
});

Deno.test("POST /connect: a non-creator is refused with 403 before Stripe", async () => {
  const db = installFakePostgrest();
  try {
    for (const seed of [{}, account({ program: "user", creator_terms_version: "2026-09-01" })]) {
      db.reset(seed);
      const res = await post("/connect", {});
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error, "Cash payouts are for approved creators.");
      assertEquals(db.writes("affiliate_accounts").length, 0);
    }
  } finally {
    db.restore();
  }
});

Deno.test("POST /tax-profile: no accepted creator terms is 403 and writes no row", async () => {
  const db = installFakePostgrest();
  try {
    for (const seed of [{}, account({ program: "user", creator_terms_version: null })]) {
      db.reset(seed);
      const res = await post("/tax-profile", FULL_TAX);
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error, "Apply to the creator program first.");
      assertEquals(db.writes("affiliate_tax_profiles").length, 0);
    }
  } finally {
    db.restore();
  }
});

Deno.test("POST /tax-profile: a certified form missing the address is 400", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(account({ program: "user", creator_terms_version: "2026-09-01" }));
    const { address_line1: _drop, ...noAddress } = FULL_TAX;
    const res = await post("/tax-profile", noAddress);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Street address is required.");
    assertEquals(db.writes("affiliate_tax_profiles").length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("POST /tax-profile: an applicant with current terms and a full form is saved", async () => {
  const db = installFakePostgrest();
  try {
    db.reset(account({ program: "user", creator_terms_version: "2026-09-01" }));
    const res = await post("/tax-profile", FULL_TAX);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.last4, "6789");
    const rows = db.tables.affiliate_tax_profiles;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].owner_user_id, ME);
    assertEquals(rows[0].region, "IA");
    assert(!JSON.stringify(body).includes("123456789"));
  } finally {
    db.restore();
  }
});

Deno.test("taxProfileProblem: names the field that is missing", () => {
  assertEquals(taxProfileProblem(FULL_TAX), null);
  assertEquals(taxProfileProblem({ ...FULL_TAX, certify: "yes" }), "Tick the box to certify your tax details.");
  assertEquals(taxProfileProblem({ ...FULL_TAX, city: " " }), "City is required.");
  assertEquals(taxProfileProblem({ ...FULL_TAX, region: "Iowa" }), "Pick your state.");
  assertEquals(taxProfileProblem({ ...FULL_TAX, postal_code: "5030" }), "ZIP code is 5 digits, or 9 with the extra 4.");
  assertEquals(taxProfileProblem({ ...FULL_TAX, postal_code: "50309-1234" }), null);
  assertEquals(taxProfileProblem({ ...FULL_TAX, postal_code: "503091234" }), null);
});

Deno.test("POST /click: returns the new click's id, and no id for an unknown code", async () => {
  const db = installFakePostgrest();
  try {
    db.reset({ referral_codes: [{ id: "rc", user_id: ME, code: "ABCD2345" }], affiliate_clicks: [] });
    const res = await post("/click", { code: "abcd2345", source: "whatsapp", path: "/" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.click_id, db.tables.affiliate_clicks[0].id);
    assertEquals(db.tables.affiliate_clicks[0].source, "whatsapp");

    const unknown = await post("/click", { code: "NOPE2345" });
    assertEquals(await unknown.json(), { ok: true });
    assertEquals(db.tables.affiliate_clicks.length, 1);
  } finally {
    db.restore();
  }
});

// ── GET /payouts ────────────────────────────────────────────────────────────

function payoutSeed(program: string, extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    system_settings: [{ id: "s", key: "affiliate_payout_config", value: { mode: "batched" } }],
    affiliate_accounts: [{ id: "acct", user_id: ME, program, payouts_enabled: true, stripe_connect_account_id: "acct_1" }],
    affiliate_commissions: [],
    affiliate_payouts: [],
    affiliate_tax_profiles: [],
    ...extra,
  };
}

Deno.test("GET /payouts: a non-creator is never offered cash", async () => {
  const db = installFakePostgrest();
  try {
    bustSettingCache();
    db.reset(payoutSeed("user"));
    const body = await (await app().request("/payouts")).json();
    assertEquals(body.enabled, false);
    assertEquals(body.program, "user");
  } finally {
    db.restore();
  }
});

Deno.test("GET /payouts: a failed transfer is in transit, not paid, and the year sums every payout", async () => {
  const db = installFakePostgrest();
  try {
    bustSettingCache();
    const now = new Date();
    const thisYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 2)).toISOString();
    const paid: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      affiliate_user_id: ME,
      amount: 1000,
      status: "paid",
      paid_at: thisYear,
      created_at: thisYear,
    }));
    paid.push({ id: "f1", affiliate_user_id: ME, amount: 2500, status: "failed", paid_at: null, created_at: thisYear });
    db.reset(payoutSeed("creator", { affiliate_payouts: paid }));
    const body = await (await app().request("/payouts")).json();
    assertEquals(body.enabled, true);
    assertEquals(body.balance.paid, 600);
    assertEquals(body.balance.in_transit, 25);
    assertEquals(body.tax.paid_this_year, 600);
    assertEquals(body.payouts.length, 50);
    assertEquals(body.tax_profile_certified, false);
    assertEquals(body.tax.threshold, 2000);
  } finally {
    db.restore();
  }
});

Deno.test("GET /payouts: a payable balance names what blocks it", async () => {
  const db = installFakePostgrest();
  try {
    bustSettingCache();
    db.reset(payoutSeed("creator", {
      affiliate_commissions: [{
        id: "c1",
        affiliate_user_id: ME,
        amount: 5000,
        status: "accrued",
        hold_until: new Date(Date.now() - 1000).toISOString(),
      }],
    }));
    const body = await (await app().request("/payouts")).json();
    assertEquals(body.balance.accrued_payable, 50);
    assertEquals(body.blocked_reason, "tax_profile_missing");
  } finally {
    db.restore();
  }
});
