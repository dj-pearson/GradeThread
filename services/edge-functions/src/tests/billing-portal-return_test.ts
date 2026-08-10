// US-2125: the billing portal must return the customer to the page that
// manages what they just changed.
//
// `return_url` was hardcoded to the SELLER billing page. A buyer clicking
// "Manage in Stripe" on /buyer/billing was sent to Stripe and returned to
// /dashboard/billing — a page that shows a FlipDesk plan they may not have and
// cannot manage their buyer subscription. The buyer product has no other route
// back, so the journey ends somewhere wrong.
//
// The eighth instance of one shape: a control built for the seller product and
// reused for the buyer one without asking whether its destination still made
// sense.

import { assert } from "@std/assert";
import { callArgs, code, fnBody } from "./_source-scan.ts";

const PAYMENTS = code(
  await Deno.readTextFile(new URL("../routes/payments.ts", import.meta.url)),
);
const HOOKS = code(
  await Deno.readTextFile(
    new URL("../../../../src/hooks/use-billing-summary.ts", import.meta.url),
  ),
);
const BUYER_PAGE = code(
  await Deno.readTextFile(
    new URL("../../../../src/pages/buyer/billing.tsx", import.meta.url),
  ),
);

Deno.test("US-2125: the return URL is resolved per product, not hardcoded", () => {
  const args = callArgs(PAYMENTS, "stripe.billingPortal.sessions.create");
  assert(
    /return_url: renewalNoticeCopy\(/.test(args),
    "the portal's return_url must come from renewalNoticeCopy so 'the page that " +
      "manages this product' has ONE definition, shared with every billing email",
  );
  assert(
    !args.includes("/dashboard/billing"),
    "a hardcoded seller path here strands every buyer who opens the portal",
  );
});

Deno.test("US-2125: an existing caller that sends no product still gets the seller page", () => {
  // Byte-identical for every historical call site. A default of "buyer" would
  // have been the mirror-image bug, and a THROW would have broken the seller
  // page for a body-less request that has always been valid.
  const body = PAYMENTS.slice(PAYMENTS.indexOf('paymentRoutes.post("/portal"'));
  assert(
    /let portalProduct: "flipdesk" \| "buyer" = "flipdesk";/.test(body),
    "the default must stay flipdesk",
  );
  assert(
    /\} catch \{/.test(body.slice(0, body.indexOf("const { data: user"))),
    "a request with no JSON body must fall through to the default, not 400",
  );
  assert(
    /body\?\.product === "buyer"/.test(body),
    "only an explicit buyer hint may change the destination",
  );
});

Deno.test("US-2125: the buyer page asks for its own return", () => {
  const hook = fnBody(HOOKS, "export function useBillingPortal");
  assert(
    /json: \{ product \}/.test(hook),
    "the hook must forward the product, or the parameter is decoration",
  );
  assert(
    /useBillingPortal\("buyer"\)/.test(BUYER_PAGE),
    "src/pages/buyer/billing.tsx must open the portal as the buyer product — " +
      "it is the only surface that lands on the wrong page without it",
  );
});
