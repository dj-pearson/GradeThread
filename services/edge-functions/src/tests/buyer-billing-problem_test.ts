// US-2452: a buyer whose card fails hears about it.
//
// The FOURTH instance of one shape in one file. handleInvoicePaymentFailed and
// handleInvoicePaymentActionRequired both open with
// `if (invoiceIsBuyer(invoice)) return;`. For the STATUS that is right —
// applyBuyerSubscriptionChange owns buyer_subscription_status. But both EMAILS
// were inside the skipped bodies, and applyBuyerSubscriptionChange sends none,
// so a declined card produced silence and then a cancellation. The
// action-required one is worse: nothing retries a bank challenge, so the notice
// IS the remedy, and its absence means the renewal simply fails.
//
// The skip's own comment said the reason was "so a buyer doesn't get a
// seller-shaped email". That was an honest statement of intent whose
// consequence nobody re-read. It is the reason these assertions are about WHERE
// the send sits, not whether a send exists somewhere.

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

const HANDLERS = [
  { name: "handleInvoicePaymentFailed", kind: "payment_failed" },
  { name: "handleInvoicePaymentActionRequired", kind: "action_required" },
] as const;

for (const h of HANDLERS) {
  Deno.test(`US-2452: ${h.name} notifies the buyer before it returns`, () => {
    const body = fn(WEBHOOKS, `async function ${h.name}`);
    const idxBranch = body.indexOf("if (invoiceIsBuyer(invoice)) {");
    assert(idxBranch > -1, `${h.name}: the buyer branch is gone`);
    const idxSend = body.indexOf(`sendBuyerBillingProblem(`);
    assert(idxSend > idxBranch, `${h.name}: the buyer is never notified`);
    assert(
      body.includes(`"${h.kind}"`),
      `${h.name} must ask for the ${h.kind} template — a declined card and a bank ` +
        "challenge have different remedies, and the wrong email points the reader " +
        "at one that will not work",
    );
    const branch = body.slice(idxBranch, body.indexOf("const user = await loadUserByCustomerId"));
    assert(
      /\breturn;/.test(branch),
      `${h.name}: the buyer branch must return, or a buyer invoice falls through ` +
        "into the seller path",
    );
  });
}

Deno.test("US-2452 AC3: the seller dunning transition stays behind the skip", () => {
  // buyer_subscription_status and the US-395 grace clock are owned by
  // customer.subscription.updated. Writing them from an invoice event would
  // make the recorded state depend on Stripe's delivery order — and writing the
  // SELLER columns for a buyer invoice would put a paying seller into dunning
  // over someone else's card.
  const body = fn(WEBHOOKS, "async function handleInvoicePaymentFailed");
  const afterSkip = body.slice(body.indexOf("if (invoiceIsBuyer(invoice)) {"));
  for (const sellerOnly of ['subscription_status: "past_due"', "past_due_since: nextPastDueSince("]) {
    assert(
      afterSkip.includes(sellerOnly),
      `${sellerOnly} must stay AFTER the buyer skip`,
    );
  }
  // And the buyer notifier must not write status at all.
  const notifier = fn(WEBHOOKS, "async function sendBuyerBillingProblem");
  for (const forbidden of ["buyer_subscription_status", "past_due_since", ".update("]) {
    assert(
      !notifier.includes(forbidden),
      `sendBuyerBillingProblem touches ${forbidden} — it notifies, it does not ` +
        "own state. subscription.updated does.",
    );
  }
});

Deno.test("US-2452: a buyer already on free is not chased for a subscription they lost", () => {
  const notifier = fn(WEBHOOKS, "async function sendBuyerBillingProblem");
  assert(
    /buyerPlan === "free"/.test(notifier),
    "a buyer on free has no buyer subscription to save",
  );
  assert(
    /buyerPlan\.charAt\(0\)/.test(notifier),
    "the email must name the BUYER plan, not the user's flipdesk_plan",
  );
});

Deno.test("US-2452 AC4: both templates take their product from the shared copy", () => {
  for (const template of [
    "export async function sendPaymentFailedEmail",
    "export async function sendPaymentActionRequiredEmail",
  ]) {
    const body = fn(EMAIL, template);
    assert(
      /const \{ productName, manageUrl \} = renewalNoticeCopy\(data\.product, SITE_URL\)/
        .test(body),
      `${template} must take BOTH values from renewalNoticeCopy(data.product, …)`,
    );
    for (const literal of ["FlipDesk", "GradeThread", "/dashboard/billing", "/buyer/billing"]) {
      assert(
        !body.includes(literal),
        `${template} hardcodes ${JSON.stringify(literal)} — the product is a parameter`,
      );
    }
  }
});

Deno.test("US-2452 AC5: every billing-problem caller states its own product", () => {
  // tsc already refuses a caller that omits `product`. It cannot catch a buyer
  // path passing "flipdesk", which compiles and sends the wrong copy.
  for (const sender of ["sendPaymentFailedEmail", "sendPaymentActionRequiredEmail"]) {
    const calls = WEBHOOKS.match(
      new RegExp(`${sender}\\(user\\.email, \\{[\\s\\S]*?\\}\\)`, "g"),
    ) ?? [];
    assertEquals(calls.length, 2, `${sender}: expected a seller and a buyer caller`);
    assertEquals(
      calls.map((c) => /product:\s*"(\w+)"/.exec(c)?.[1]).sort(),
      ["buyer", "flipdesk"],
      `${sender}: one caller per product, each naming its own`,
    );
  }
});
