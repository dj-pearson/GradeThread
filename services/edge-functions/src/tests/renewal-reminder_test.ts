// US-2119: the advance renewal reminder (invoice.upcoming → handleInvoiceUpcoming
// → sendRenewalReminderEmail) must be TRANSACTIONAL, so a marketing opt-out
// cannot suppress the one notice that warns an annual subscriber they are about
// to be charged. This mirrors the US-2120 guard for the trial-ending notice:
// without it, moving "subscription_renewal_reminder" out of
// TRANSACTIONAL_CATEGORIES would silently make the reminder suppressible and no
// test would catch it — a paid customer charged with no warning.
//
//   deno test --allow-env src/tests/renewal-reminder_test.ts

import { assert, assertEquals } from "@std/assert";
import { renewalNoticeCopy } from "../lib/renewal-notice-copy.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { TRANSACTIONAL_CATEGORIES, resolveIsMarketing } = await import(
  "../lib/email-transport.ts"
);

// THE LOAD-BEARING ONE (AC3 + AC5's opt-out half). If this category is ever
// reclassified marketing, the renewal reminder becomes suppressible and the
// whole compliance guarantee regresses silently.
Deno.test("US-2119: subscription_renewal_reminder is TRANSACTIONAL and cannot be sent as marketing", () => {
  assert(
    TRANSACTIONAL_CATEGORIES.has("subscription_renewal_reminder"),
    "the renewal reminder must be transactional — otherwise a marketing " +
      "opt-out suppresses the only advance warning of an automatic charge",
  );
  // The hard guard: even explicitly asking for marketing must not move it.
  assert(
    resolveIsMarketing({ category: "subscription_renewal_reminder", marketing: true }) ===
      false,
    "a known-transactional category must be force-classified transactional " +
      "regardless of the requested flag",
  );
});

// AC3's structural half: the handler must send the reminder DIRECTLY via the
// transactional sender, never route it through the drip/marketing engine (whose
// opt-out / suppression / frequency-cap checks are what would suppress it).
Deno.test("US-2119: handleInvoiceUpcoming sends via the transactional sender, not the drip", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  // Anchor on the CALL (syntax that only appears in code), not prose.
  assert(
    /sendRenewalReminderEmail\(/.test(src),
    "the transactional renewal sender must actually be called from the webhook",
  );
  assert(
    /case "invoice\.upcoming":/.test(src),
    "invoice.upcoming must be dispatched (not fall through to log-and-drop)",
  );
});

// ── The buyer product (US-2119, second pass) ────────────────────────────────

Deno.test("US-2119: the notice names the product being charged and links to the page that cancels it", () => {
  const site = "https://gradethread.com";
  const seller = renewalNoticeCopy("flipdesk", site);
  const buyer = renewalNoticeCopy("buyer", site);

  assertEquals(seller.productName, "FlipDesk");
  assertEquals(seller.manageUrl, "https://gradethread.com/dashboard/billing");
  assertEquals(buyer.productName, "GradeThread");
  assertEquals(buyer.manageUrl, "https://gradethread.com/buyer/billing");

  // BOTH must differ. A half-copied branch — right name, seller's billing page —
  // produces a notice that reads correctly and sends the reader somewhere that
  // cannot cancel the thing they are about to be charged for.
  assert(seller.productName !== buyer.productName, "the product name must differ");
  assert(seller.manageUrl !== buyer.manageUrl, "the manage URL must differ");
  // A trailing slash on SITE_URL must not produce a double slash in a link the
  // recipient is being asked to click under time pressure.
  assertEquals(renewalNoticeCopy("buyer", site + "/").manageUrl, buyer.manageUrl);
});

Deno.test("US-2119: the template interpolates the product copy instead of hardcoding one product", async () => {
  const src = await Deno.readTextFile(new URL("../lib/email.ts", import.meta.url));
  const start = src.indexOf("export async function sendRenewalReminderEmail");
  assert(start > -1, "sendRenewalReminderEmail not found — renamed?");
  const body = src.slice(start, src.indexOf("\n}", start));

  // The DESTRUCTURE, not merely the call: keeping the call for one value and
  // hardcoding the other is the shape that slipped past the receipt's version
  // of this assertion, and it is the shape that sends every buyer the seller's
  // copy.
  assert(
    /const \{ productName, manageUrl \} = renewalNoticeCopy\(data\.product, SITE_URL\)/
      .test(body),
    "the template must take BOTH its product name and its manage link from " +
      "renewalNoticeCopy(data.product, …), so the tested values are the sent values",
  );
  // No product name may be written here at all.
  for (const literal of ["FlipDesk", "GradeThread", "/dashboard/billing", "/buyer/billing"]) {
    assert(
      !body.includes(literal),
      `sendRenewalReminderEmail hardcodes ${JSON.stringify(literal)} — the ` +
        "product is a parameter now",
    );
  }
});

Deno.test("US-2119: every buyer skip in the Stripe webhooks says where the buyer path went", async () => {
  // THE GUARD FOR THE DEFECT ITSELF. handleInvoiceUpcoming carried
  // `if (invoiceIsBuyer(invoice)) return;`, copied from three handlers where it
  // is CORRECT — those do seller cycle resets and dunning, and the buyer
  // equivalent arrives on customer.subscription.updated. This handler only
  // sends a notice, and nothing else sends one, so the same line meant a buyer
  // on an ANNUAL plan was charged with no prior contact at all.
  //
  // A skip is not wrong; an UNEXPLAINED skip is. Each one must name where the
  // buyer is served instead, in the comment lines just above it — so the next
  // person who copies the line has to answer the question that was skipped
  // here.
  const src = await Deno.readTextFile(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  //
  // Matches BOTH shapes: the bare `… ) return;` and the branch form
  // `… ) {` that US-2451 introduced so the buyer receipt could be sent before
  // the return. The first version of this guard matched only the bare form, so
  // opening a branch would have quietly dropped that handler out of the census
  // — a guard that stops counting is worse than one that never counted.
  const lines = src.split(/\r?\n/);
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/if \(invoiceIsBuyer\(invoice\)\)\s*(return;|\{)/.test(lines[i]!)) continue;
    checked++;
    const preamble = lines.slice(Math.max(0, i - 12), i).join(" ");
    assert(
      /subscription\.updated/.test(preamble),
      `webhooks.ts:${i + 1} skips buyer invoices without naming where the buyer ` +
        "path is served instead. If the answer is 'nowhere', the skip is a " +
        "silently-missing notice, not a routing decision.",
    );
  }
  assert(checked >= 3, `expected the known buyer skips, found ${checked}`);

  // And the notice handler must not have one at all.
  const upcoming = src.slice(src.indexOf("async function handleInvoiceUpcoming"));
  const body = upcoming.slice(0, upcoming.indexOf("\n}"));
  assert(
    !/if \(invoiceIsBuyer\(invoice\)\) return;/.test(body),
    "handleInvoiceUpcoming must NOT skip buyer invoices — it is the only place " +
      "an advance renewal notice is sent, so skipping means no notice exists",
  );
  // Scoped to the EMAIL call, not the whole handler. The same expression also
  // appears in the recordEvent payload a few lines above, so a handler-wide
  // check stayed green when the email argument alone was pinned to "flipdesk" —
  // which is the version that sends a buyer the wrong notice.
  const emailCall = body.slice(body.indexOf("sendRenewalReminderEmail("));
  assert(emailCall.length > 0, "the reminder send was not found in the handler");
  assert(
    /product: isBuyer \? "buyer" : "flipdesk"/.test(
      emailCall.slice(0, emailCall.indexOf("}),")),
    ),
    "the EMAIL must be told which product is renewing — a constant here sends " +
      "buyers a notice naming FlipDesk and linking to the seller billing page",
  );
});
