// US-2451: a buyer is charged on renewal and hears about it afterwards.
//
// The receipt lived inside handleInvoicePaymentSucceeded, whose first act is
// `if (invoiceIsBuyer(invoice)) return;`. That skip is CORRECT — everything
// below it is seller cycle-reset work (grade and AI counters,
// subscription_status) that must not fire for a buyer invoice — and the receipt
// was simply sitting inside the protected region. Nothing else sends one, so a
// buyer paid and got silence. Paired with US-2119, which was the same omission
// on the advance notice, in the same file, from the same copied line.
//
// Source-scanned, like renewal-reminder_test.ts: the handler is a Stripe +
// service-role path that cannot be invoked in isolation, and the property under
// test is structural — WHERE the send sits relative to the skip.

import { assert, assertEquals } from "@std/assert";

const WEBHOOKS = await Deno.readTextFile(
  new URL("../routes/webhooks.ts", import.meta.url),
);
const EMAIL = await Deno.readTextFile(new URL("../lib/email.ts", import.meta.url));

/** The body of one function, brace-matched from its declaration. */
function fn(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  assert(at > -1, `${declaration} not found — renamed?`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i);
  }
  throw new Error(`unbalanced braces in ${declaration}`);
}

Deno.test("US-2451: the buyer receipt is sent BEFORE the skip returns", () => {
  const body = fn(WEBHOOKS, "async function handleInvoicePaymentSucceeded");
  const idxSend = body.indexOf("sendBuyerRenewalReceipt(");
  const idxReturn = body.indexOf("if (invoiceIsBuyer(invoice)) {");
  assert(idxSend > -1, "the buyer receipt is never sent from this handler");
  assert(idxReturn > -1, "the buyer skip is gone — the seller cycle resets are now unguarded");
  assert(
    idxSend > idxReturn,
    "the send must be inside the buyer branch, not before the check",
  );
});

Deno.test("US-2451 AC2: the seller cycle resets stay behind the skip", () => {
  // The tempting fix was to widen the skip and thread `isBuyer` past every
  // reset below it. One missed branch there zeroes a SELLER's grade and AI
  // quota on a BUYER's renewal — a worse bug than the one being fixed, and one
  // that shows up as a support ticket about vanished credits.
  const body = fn(WEBHOOKS, "async function handleInvoicePaymentSucceeded");
  const afterSkip = body.slice(body.indexOf("if (invoiceIsBuyer(invoice)) {"));
  for (const sellerOnly of [
    "grades_used_this_month: 0",
    "ai_actions_used_this_month: 0",
    'subscription_status: "active"',
  ]) {
    assert(
      afterSkip.includes(sellerOnly),
      `${sellerOnly} must stay AFTER the buyer skip — it is seller-only work`,
    );
  }
  // And the buyer branch must still return, so none of it runs.
  const branch = body.slice(
    body.indexOf("if (invoiceIsBuyer(invoice)) {"),
    body.indexOf("const user = await loadUserByCustomerId"),
  );
  assert(
    /\breturn;/.test(branch),
    "the buyer branch must return — otherwise a buyer invoice falls through " +
      "into the seller cycle reset",
  );
});

Deno.test("US-2451: only a renewal is receipted, and only for a live buyer plan", () => {
  const body = fn(WEBHOOKS, "async function sendBuyerRenewalReceipt");
  assert(
    /billing_reason !== "subscription_cycle"/.test(body),
    "the first charge is covered by the subscription-started path; receipting " +
      "subscription_create here would double up on signup",
  );
  assert(
    /buyerPlan === "free"/.test(body),
    'a lapsed buyer has nothing to receipt, and naming "Free" on a charge ' +
      "confirmation is worse than sending nothing",
  );
});

Deno.test("US-2451 AC3: the receipt names the product through the shared copy", () => {
  const body = fn(EMAIL, "export async function sendSubscriptionRenewalReceiptEmail");
  // BOTH VALUES must come off the call, pinned as a destructure. Asserting only
  // that renewalNoticeCopy is CALLED was not enough: a sabotage that kept the
  // call for manageUrl and set `const productName = "FlipDesk"` left this green
  // while every buyer receipt named the seller product. Same shape of miss as
  // the three earlier today — the check passed over the one value that mattered.
  assert(
    /const \{ productName, manageUrl \} = renewalNoticeCopy\(data\.product, SITE_URL\)/
      .test(body),
    "the receipt must take BOTH its product name and its billing link from " +
      "renewalNoticeCopy(data.product, …) — two subscriptions, one naming rule",
  );
  // No product name may be written here at all. There is no longer a legitimate
  // reason for the string to appear in this function.
  for (const literal of ["FlipDesk", "GradeThread", "/dashboard/billing", "/buyer/billing"]) {
    assert(
      !body.includes(literal),
      `sendSubscriptionRenewalReceiptEmail hardcodes ${JSON.stringify(literal)} — ` +
        "the product is a parameter now",
    );
  }
});

Deno.test("US-2451: every caller states which product renewed", () => {
  // `product` is required with no default on both templates, so tsc already
  // refuses a caller that omits it. This pins the VALUES, which tsc cannot:
  // passing "flipdesk" from the buyer path compiles perfectly and sends the
  // wrong receipt.
  const calls = WEBHOOKS.match(/sendSubscriptionRenewalReceiptEmail\([\s\S]*?\}\);/g) ?? [];
  assertEquals(calls.length, 2, "expected exactly the seller and buyer receipts");
  const products = calls.map((c) => /product:\s*"(\w+)"/.exec(c)?.[1]).sort();
  assertEquals(products, ["buyer", "flipdesk"]);

  const buyerCall = calls.find((c) => c.includes('product: "buyer"'))!;
  assert(
    buyerCall.includes("buyerPlan"),
    "the buyer receipt must name the BUYER plan, not the user's flipdesk_plan",
  );
});
