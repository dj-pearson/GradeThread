// US-1800: buyer metered-action reserve/refund contract. Deps injected so this
// runs without a DB.
import { assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { withBuyerMeter, BuyerQuotaExhaustedError, BUYER_METER_ALLOWANCE } = await import(
  "../lib/buyer-metering.ts"
);

Deno.test("withBuyerMeter: runs the action when reserved", async () => {
  let refunded = 0;
  const out = await withBuyerMeter("u1", "extension_checks", 10, () => Promise.resolve("ok"), {
    reserve: () => Promise.resolve(true),
    refund: () => { refunded++; return Promise.resolve(); },
  });
  assertEquals(out, "ok");
  assertEquals(refunded, 0);
});

Deno.test("withBuyerMeter: throws BuyerQuotaExhaustedError at the cap (no run, no refund)", async () => {
  let ran = 0, refunded = 0;
  await assertRejects(
    () =>
      withBuyerMeter("u1", "authenticity_credits", 3, () => { ran++; return Promise.resolve("x"); }, {
        reserve: () => Promise.resolve(false),
        refund: () => { refunded++; return Promise.resolve(); },
      }),
    BuyerQuotaExhaustedError,
  );
  assertEquals(ran, 0);
  assertEquals(refunded, 0);
});

Deno.test("withBuyerMeter: refunds when the reserved work throws, then rethrows", async () => {
  let refunded: string | null = null;
  await assertRejects(
    () =>
      withBuyerMeter("u1", "video_grades", 2, () => Promise.reject(new Error("boom")), {
        reserve: () => Promise.resolve(true),
        refund: (_o, meter) => { refunded = meter; return Promise.resolve(); },
      }),
    Error,
    "boom",
  );
  assertEquals(refunded, "video_grades");
});

Deno.test("BUYER_METER_ALLOWANCE maps each meter to its allowance cap key", () => {
  assertEquals(BUYER_METER_ALLOWANCE.extension_checks, "extensionChecksPerMonth");
  assertEquals(BUYER_METER_ALLOWANCE.authenticity_credits, "authenticityCreditsPerMonth");
  assertEquals(BUYER_METER_ALLOWANCE.video_grades, "videoGradeCreditsPerMonth");
});
