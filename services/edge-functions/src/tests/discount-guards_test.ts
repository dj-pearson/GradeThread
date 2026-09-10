// US-3299 — the security and correctness properties of the discount module that
// a SOURCE scan can actually establish.
//
// The behavioural tenant-isolation cases for this feature would be empty
// ceremony: discount_campaigns is a GLOBAL operator table with no tenant column,
// so there is no cross-tenant read to attempt. What can go wrong is different,
// and all four of these have a plausible bad edit behind them:
//
//   1. a mutation route losing the super_admin / step-up gate,
//   2. the public RLS policy widening to expose unannounced or unsynced campaigns,
//   3. a checkout applying a campaign coupon OVER a coupon promised to one user,
//   4. `discounts` set while `allow_promotion_codes` is still on, which Stripe
//      rejects outright — a 400 at the moment of payment.
import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../../../../", import.meta.url);

function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, ROOT));
}

const ROUTE = read("services/edge-functions/src/routes/admin-discounts.ts");
const PAYMENTS = read("services/edge-functions/src/routes/payments.ts");
const MIGRATION = read("supabase/migrations/00778_discount_campaigns.sql");

Deno.test("every mutating admin-discounts route is behind the super_admin + step-up guard", () => {
  // Each `.post(`/`.put(`/`.delete(` handler must call guard() before it touches
  // anything. GET is exempt: reading the campaign list is not a money action.
  const handlers = [...ROUTE.matchAll(
    /adminDiscountsRoutes\.(post|put|delete)\(\s*"([^"]+)"[\s\S]*?\n\}\);/g,
  )];
  assert(handlers.length >= 5, `expected the 5 mutating routes, found ${handlers.length}`);

  for (const h of handlers) {
    const [body, verb, path] = [h[0], h[1], h[2]];
    assert(
      body.includes("const blocked = guard(c);") && body.includes("if (blocked) return blocked;"),
      `${verb!.toUpperCase()} ${path} does not call guard() — it would let a plain admin ` +
        "change live prices without a fresh MFA step-up",
    );
  }
});

Deno.test("guard() checks super_admin AND step-up, not one or the other", () => {
  const guard = ROUTE.slice(ROUTE.indexOf("function guard("));
  const body = guard.slice(0, guard.indexOf("\n}") + 2);
  assert(body.includes('adminRole") !== "super_admin"'), "guard() lost the super_admin check");
  assert(body.includes("requireStepUp(c)"), "guard() lost the MFA step-up check");
});

Deno.test("every mutating admin-discounts route writes an audit row", () => {
  // Deliberately counted rather than matched per-route: the toggle route writes
  // one of two actions depending on direction, so a per-route string match would
  // have to encode that and would rot.
  const mutations = (ROUTE.match(/adminDiscountsRoutes\.(post|put|delete)\(/g) ?? []).length;
  const audits = (ROUTE.match(/writeAuditLog\(c, \{/g) ?? []).length;
  assertEquals(
    audits,
    mutations,
    "a mutating discount route does not write an audit row — a price change with " +
      "nothing saying who made it",
  );
});

Deno.test("the public read policy stays narrowed to live, synced campaigns", () => {
  const start = MIGRATION.indexOf('create policy "discount_campaigns_public_read"');
  assert(start > -1, "the public read policy is gone");
  const policy = MIGRATION.slice(start, MIGRATION.indexOf(";", start));

  // Each clause is load-bearing and each has its own failure:
  //   enabled            — a killed sale keeps discounting
  //   stripe_coupon_id   — a card advertises a discount checkout then refuses
  //   starts_at <= now() — next month's unannounced sale is readable today
  //   ends_at > now()    — an expired sale keeps discounting
  for (const clause of ["enabled", "stripe_coupon_id is not null", "starts_at <= now()", "ends_at > now()"]) {
    assert(policy.includes(clause), `the public read policy no longer requires: ${clause}`);
  }
});

Deno.test("writes to discount_campaigns are revoked for anon and authenticated", () => {
  assert(
    /revoke insert, update, delete on public\.discount_campaigns from anon, authenticated/
      .test(MIGRATION),
    "anon/authenticated can write discount_campaigns — anyone with the browser key " +
      "could mint themselves a 100% sale",
  );
});

Deno.test("a campaign never takes a coupon slot a per-user coupon already claimed", () => {
  // applyCampaignDiscount bails when sessionParams.discounts is already set. That
  // ordering is the whole precedence rule (referral > drip > reward > campaign),
  // and it is expressed by WHERE the call sits, so pin both halves.
  const store = read("services/edge-functions/src/lib/discount-store.ts");
  const fn = store.slice(store.indexOf("export async function applyCampaignDiscount"));
  assert(
    fn.slice(0, 600).includes("if (sessionParams.discounts) return null;"),
    "applyCampaignDiscount no longer yields to an existing coupon — a site-wide " +
      "sale would overwrite a discount promised to one person",
  );

  // And in payments.ts it must come AFTER the reward lookup in both places that
  // have one.
  for (const rewardCall of ["loadActiveDiscount(userId, \"subscription_discount\")", "loadActiveDiscount(userId, \"per_grade_discount\")"]) {
    const rewardAt = PAYMENTS.indexOf(rewardCall);
    assert(rewardAt > -1, `payments.ts no longer calls ${rewardCall}`);
    const campaignAt = PAYMENTS.indexOf("applyCampaignDiscount(sessionParams", rewardAt);
    assert(
      campaignAt > rewardAt,
      `applyCampaignDiscount runs before ${rewardCall} — the sale would win over ` +
        "the reward the seller earned",
    );
  }
});

Deno.test("no checkout sets discounts while allow_promotion_codes is still on", () => {
  // Stripe rejects the combination with a 400, at the moment of payment. Every
  // site that assigns `discounts` must delete the flag first.
  const assignments = [...PAYMENTS.matchAll(/sessionParams\.discounts = /g)];
  assert(assignments.length >= 4, `expected the coupon assignments, found ${assignments.length}`);
  for (const m of assignments) {
    const before = PAYMENTS.slice(Math.max(0, m.index! - 300), m.index!);
    assert(
      before.includes("delete sessionParams.allow_promotion_codes;"),
      "a checkout sets sessionParams.discounts without deleting " +
        "allow_promotion_codes — Stripe 400s on the combination",
    );
  }
});

Deno.test("every campaign-aware checkout folds the campaign into its idempotency key", () => {
  // Stripe replays a cached session for 24h. Without the campaign in the key, a
  // user who opened checkout before a sale started is handed the pre-sale session
  // and charged list price with the discount on the card behind them.
  const calls = (PAYMENTS.match(/applyCampaignDiscount\(sessionParams/g) ?? []).length;
  const suffixes = (PAYMENTS.match(/discountKeySuffix\(campaignDiscount\)/g) ?? []).length;
  assertEquals(
    suffixes,
    calls,
    "a checkout applies a campaign but does not vary its idempotency key by it",
  );
  assertEquals(calls, 5, "expected 5 campaign-aware checkouts (flipdesk, buyer, credit pack, action pack, per-grade)");
});
