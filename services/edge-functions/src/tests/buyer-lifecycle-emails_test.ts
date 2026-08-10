// US-2453: a buyer subscription now starts and ends with an acknowledgement.
//
// The FIFTH instance of one shape in webhooks.ts. handleSubscriptionChange
// dispatches a buyer subscription to applyBuyerSubscriptionChange and RETURNS,
// and every lifecycle email lived below that return. So a buyer's first
// purchase produced nothing from us, and cancelling produced no confirmation of
// what was cancelled or when access ends. handleSubscriptionDeleted's buyer
// branch also returned before recordEvent, so the one event that ends a paid
// relationship left no audit row.
//
// The assertions are structural for the same reason as the sibling files: these
// handlers are Stripe + service-role paths that cannot be invoked in isolation,
// and the property under test is WHERE the send sits and WHAT it reads.

import { assert, assertEquals } from "@std/assert";

/**
 * Source with WHOLE-LINE comments removed.
 *
 * Every assertion here reads this rather than the raw file. Five times in one
 * day a guard has passed because the explanatory comment above the code
 * contained the identifier the guard was looking for — including twice in this
 * very file, where the comment saying "there is no buyer_pause_until" satisfied
 * the check for a buyer pause column. Only full lines are stripped, so a `//`
 * inside a URL in a template string survives.
 */
function code(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

const WEBHOOKS = code(
  await Deno.readTextFile(new URL("../routes/webhooks.ts", import.meta.url)),
);
const EMAIL = code(await Deno.readTextFile(new URL("../lib/email.ts", import.meta.url)));

/**
 * The BODY of one function, brace-matched.
 *
 * Finds the brace after the parameter list closes, not the first brace after
 * the name — applyBuyerSubscriptionChange takes an inline object TYPE, so
 * `indexOf("{")` lands inside the parameter annotation and the match closes at
 * the end of it. That produced five failures that looked like missing code.
 */
function fn(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  assert(at > -1, `${declaration} not found — renamed?`);
  let parens = 0;
  let i = src.indexOf("(", at);
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open, j);
  }
  throw new Error(`unbalanced braces in ${declaration}`);
}

const BUYER_CHANGE = () => fn(WEBHOOKS, "async function applyBuyerSubscriptionChange");

Deno.test("US-2453 AC1: a buyer purchase is acknowledged", () => {
  const body = BUYER_CHANGE();
  assert(
    body.includes("sendSubscriptionStartedEmail("),
    "a buyer's first paid subscription must be acknowledged — it was not, because " +
      "every lifecycle email sat below handleSubscriptionChange's buyer return",
  );
  assert(
    /product: "buyer"/.test(body),
    "the acknowledgement must name the buyer product",
  );
});

Deno.test("US-2453 AC1: the purchase test is a STATE TRANSITION, not the event type", () => {
  // US-2122 AC4's lesson, repeated. A trial conversion and an in-place plan
  // change both arrive as subscription.updated, so keying off `.created` misses
  // the two moments a purchase most needs acknowledging — while acknowledging
  // every `.updated` mails someone on renewals and cancel-toggle changes that
  // are not purchases.
  //
  // Pins the DERIVATIONS, not the identifiers. `const trialConverted = false;`
  // satisfies a check for the name `trialConverted` while disabling the branch
  // entirely — the same use-versus-derivation miss that got past the US-2118
  // gate guard, and past three others today.
  const body = BUYER_CHANGE();
  assert(
    /const trialConverted = wasTrialing && status === "active";/.test(body),
    "trialConverted must be DERIVED from the prior status and the new one — a " +
      "constant here silently stops acknowledging every trial conversion",
  );
  assert(
    /const planChanged = \(user\.buyer_plan \?\? "free"\) !== plan;/.test(body),
    "planChanged must be DERIVED from the stored plan against the incoming one",
  );
  assert(
    /isNewPurchase =[\s\S]{0,300}trialConverted \|\| planChanged/.test(body),
    "both transitions must feed isNewPurchase",
  );
  assert(
    /customer\.subscription\.created/.test(body) &&
      /customer\.subscription\.updated/.test(body),
    "both event types participate; neither alone decides",
  );
});

Deno.test("US-2453 AC6: the transition reads BUYER prior state, never the seller columns", () => {
  // The tempting copy-paste is US-2122's seller block, which compares
  // user.subscription_status and user.flipdesk_plan. Reading those here would
  // acknowledge a buyer purchase because their SELLER plan changed, or stay
  // silent because it did not — a bug that only shows up for people who hold
  // both subscriptions, which is the population least likely to be tested.
  const body = BUYER_CHANGE();
  assert(
    /user\.buyer_subscription_status === "trialing"/.test(body),
    "the trial test must read buyer_subscription_status",
  );
  assert(
    /user\.buyer_plan \?\? "free"\) !== plan/.test(body),
    "the plan-change test must compare the BUYER plan",
  );
  assert(
    /!user\.buyer_cancel_at_period_end/.test(body),
    "the cancellation edge must compare buyer_cancel_at_period_end",
  );
  for (const sellerColumn of [
    "user.subscription_status",
    "user.flipdesk_plan",
    "user.flipdesk_cancel_at_period_end",
  ]) {
    assert(
      !body.includes(sellerColumn),
      `applyBuyerSubscriptionChange reads ${sellerColumn} — that is the seller's ` +
        "state, and using it here misfires for anyone holding both subscriptions",
    );
  }
  // The prior values have to be selected, or they are undefined and every
  // comparison silently reads as "no change".
  for (const column of ["buyer_subscription_status", "buyer_cancel_at_period_end"]) {
    assert(
      new RegExp(`USER_SELECT[\\s\\S]{0,900}${column}`).test(WEBHOOKS),
      `${column} must be in USER_SELECT — without it the transition tests compare ` +
        "against undefined and never fire",
    );
  }
});

Deno.test("US-2453 AC2: a scheduled cancellation is confirmed, edge-triggered", () => {
  const body = BUYER_CHANGE();
  const at = body.indexOf("sendSubscriptionCanceledEmail(");
  assert(at > -1, "a buyer cancelling must be told what ends and when");
  const guard = body.slice(Math.max(0, at - 400), at);
  assert(
    /sub\.cancel_at_period_end/.test(guard) && /!user\.buyer_cancel_at_period_end/.test(guard),
    "the confirmation must fire on the false→true edge only — Stripe sends many " +
      "updates while a cancellation is pending and each would re-send",
  );
});

Deno.test("US-2453 AC5: pause and resume are deliberately NOT sent to buyers", () => {
  // Pinned as an ABSENCE so it reads as a decision. Pause is keyed on
  // flipdesk_pause_until, a seller column; there is no buyer_pause_until and no
  // buyer pause UI, so an email here would describe a state a buyer cannot
  // enter through the product.
  const body = BUYER_CHANGE();
  for (const sender of ["sendSubscriptionPausedEmail", "sendSubscriptionResumedEmail"]) {
    assert(
      !body.includes(sender),
      `${sender} is sent to buyers. If a buyer pause feature now exists, this ` +
        "test should change WITH it — the absence was a decision, not an oversight.",
    );
  }
  assert(
    !/buyer_pause_until/.test(WEBHOOKS),
    "a buyer pause column now exists — revisit the decision above",
  );
});

Deno.test("US-2119 AC4: a buyer trial-will-end is not sent the seller's trial copy", () => {
  // The INVERSE of the five omissions: not silence, but confidently wrong.
  // handleTrialWillEnd was not product-aware, so a buyer with a Stripe-managed
  // trial would have been told their "14-day FlipDesk Pro trial" was ending and
  // sent to the seller billing page to add a card.
  //
  // Skipped rather than given new copy, because a buyer Stripe trial is not a
  // product state today — and that premise is what the next assertion pins.
  const body = fn(WEBHOOKS, "async function handleTrialWillEnd");
  const idxGuard = body.indexOf("if (subscriptionIsBuyer(sub))");
  const idxSend = body.indexOf("sendTrialExpiringEmail(");
  assert(idxGuard > -1, "handleTrialWillEnd must branch on the product");
  assert(idxSend > -1, "the seller trial notice must still be sent");
  assert(
    idxGuard < idxSend,
    "the buyer branch must come BEFORE the send, or a buyer still receives the " +
      "seller's trial email",
  );
});

Deno.test("US-2119 AC4: the premise of that skip is guarded, not assumed", () => {
  // The skip is only defensible while /buyer/subscribe creates no trial. If a
  // buyer trial ever ships, this fails and points at the decision — which is
  // the difference between a decision and an omission that outlived its reason.
  const payments = code(
    Deno.readTextFileSync(new URL("../routes/payments.ts", import.meta.url)),
  );
  const at = payments.indexOf('paymentRoutes.post("/buyer/subscribe"');
  assert(at > -1, "the buyer subscribe route was renamed");
  const route = payments.slice(at, payments.indexOf("paymentRoutes.post(", at + 50));
  for (const trial of ["trial_period_days", "trial_end"]) {
    assert(
      !route.includes(trial),
      `/buyer/subscribe now sets ${trial} — buyer trials exist, so ` +
        "handleTrialWillEnd's buyer skip needs replacing with real copy",
    );
  }
});

Deno.test("US-2453 AC3: a buyer's final cancellation is audited", () => {
  const body = fn(WEBHOOKS, "async function handleSubscriptionDeleted");
  const branch = body.indexOf("if (subscriptionIsBuyer(sub)) {");
  assert(branch > -1, "the buyer branch is gone");
  const idxRecord = body.indexOf("recordEvent(", branch);
  const idxUpdate = body.indexOf('buyer_plan: "free"', branch);
  assert(idxRecord > -1 && idxRecord < idxUpdate, "the audit row must be written");
  // No email: the seller path sends none here either, because the confirmation
  // already went out when the cancellation was scheduled.
  const buyerBranch = body.slice(branch, idxUpdate + 400);
  assert(
    !/safeSendEmail\(/.test(buyerBranch),
    "no email at final deletion — the scheduled-cancellation confirmation is the notice",
  );
});

Deno.test("US-2453 AC4: both lifecycle templates take their product from the shared copy", () => {
  for (const template of [
    "export async function sendSubscriptionStartedEmail",
    "export async function sendSubscriptionCanceledEmail",
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

Deno.test("US-2453: the cancellation email does not promise a buyer someone else's data", () => {
  // "Your inventory, listings, past grade reports and grade credits all stay
  // safe" is true for a seller and meaningless to a buyer, on the one email
  // sent at the moment they are least inclined to overlook a mistake.
  const body = fn(EMAIL, "export async function sendSubscriptionCanceledEmail");
  assert(/data\.product === "buyer"/.test(body), "the retained-data line must be per product");
  assert(
    !/\$\{kept\}[\s\S]{0,80}inventory/.test(body),
    "the seller wording must not be the fallthrough for a buyer",
  );
});

Deno.test("US-2453: every lifecycle caller states its own product", () => {
  for (const sender of ["sendSubscriptionStartedEmail", "sendSubscriptionCanceledEmail"]) {
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
