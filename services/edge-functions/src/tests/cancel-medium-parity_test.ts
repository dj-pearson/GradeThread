// US-2125 AC4: cancellation is available in the SAME MEDIUM as signup.
//
// AC4 was recorded as "stated in the story as already satisfied" — taken on the
// audit's word rather than checked. The web half held up: billing.tsx hides
// every Stripe CTA behind isAppstoreManaged and points at the iOS app, and iOS
// presents .manageSubscriptionsSheet rather than calling a server cancel.
//
// THE SERVER HALF DID NOT. appstoreSubscriptionBlocksStripe guarded the
// subscribe and plan-change endpoints and NOT the cancel endpoint. An App Store
// subscriber has no flipdesk_subscription_id, so POST /flipdesk/cancel fell
// through to "No subscription to cancel" — a 400 telling a paying customer they
// have nothing, while Apple kept billing them. Someone who believes that
// message concludes they are not subscribed, and the next thing they hear is a
// renewal receipt.
//
// Hiding a button is not enforcement: the endpoint is reachable from any client
// that has a token, and the iOS app talks to the same API. So the parity rule
// has to hold at the route, which is what this pins.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { appstoreSubscriptionBlocksStripe, googleplaySubscriptionActive } =
  await import("../lib/appstore/precedence.ts");

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const PAYMENTS = read("../routes/payments.ts");

/** A route handler's body, up to the next route registration. */
function handler(path: string): string {
  const at = PAYMENTS.indexOf(`paymentRoutes.post("${path}"`);
  assert(at > -1, `POST ${path} is gone or was renamed`);
  const rest = PAYMENTS.slice(at + 1);
  const next = rest.search(/\npaymentRoutes\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

Deno.test("US-2125 AC4: the precedence helpers still identify in-app subscribers", () => {
  // The decisions the route guards depend on. If these stop returning true, the
  // route checks below still exist and silently permit everything.
  for (const status of ["active", "trialing", "past_due"]) {
    assertEquals(
      appstoreSubscriptionBlocksStripe({ billing_source: "appstore", subscription_status: status }),
      true,
      `an ${status} App Store subscriber is no longer recognised`,
    );
    assertEquals(
      googleplaySubscriptionActive({ billing_source: "googleplay", subscription_status: status }),
      true,
      `an ${status} Google Play subscriber is no longer recognised`,
    );
  }
  // A Stripe subscriber must NOT be caught by either, or web cancellation
  // breaks for the people it is for.
  assertEquals(
    appstoreSubscriptionBlocksStripe({ billing_source: "stripe", subscription_status: "active" }),
    false,
  );
  assertEquals(
    googleplaySubscriptionActive({ billing_source: "stripe", subscription_status: "active" }),
    false,
  );
});

Deno.test("US-2125 AC4: CANCEL refuses an in-app subscriber and says where to go", () => {
  const body = handler("/flipdesk/cancel");
  assert(
    /appstoreSubscriptionBlocksStripe\(user\)/.test(body),
    "the cancel endpoint no longer recognises an App Store subscription, so " +
      "the subscriber is told 'No subscription to cancel' while Apple keeps " +
      "billing them",
  );
  assert(
    /googleplaySubscriptionActive\(user\)/.test(body),
    "the cancel endpoint no longer recognises a Google Play subscription",
  );
  // The ACTION is the useful half — an error alone leaves the user stuck.
  assert(
    /action: "manage_in_app"/.test(body),
    "the refusal no longer tells the user to manage it in the app",
  );
  assert(
    /action: "manage_in_play"/.test(body),
    "the Play refusal no longer names where to go",
  );
});

Deno.test("US-2125 AC4: the medium check runs BEFORE the no-subscription check", () => {
  // Ordering is the whole defect. Both checks can be present and the wrong one
  // can still win: an App Store subscriber has no flipdesk_subscription_id, so
  // if "No subscription to cancel" is evaluated first they get that message and
  // never see the redirect.
  // COMMENTS STRIPPED. The comment above the guard QUOTES "No subscription to
  // cancel" to explain what the bug was, and that comment sits BEFORE the
  // guard — so the raw scan found the string in the explanation and reported
  // the ordering as still broken. Fourth time this session a guard matched the
  // prose describing it rather than the code.
  const body = handler("/flipdesk/cancel")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const mediumAt = body.indexOf("appstoreSubscriptionBlocksStripe(user)");
  const missingAt = body.indexOf('"No subscription to cancel"');
  assert(mediumAt > -1, "the medium check is gone");
  assert(missingAt > -1, "the no-subscription check is gone or was reworded");
  assert(
    mediumAt < missingAt,
    "an App Store subscriber now falls to 'No subscription to cancel' again — " +
      "the message that tells a paying customer they have nothing",
  );
});

Deno.test("US-2125 AC4: the purchase paths keep their guards too", () => {
  // Not a new property — a pin. Cancel and purchase have to agree about who is
  // in-app managed, and this story is about them having drifted apart once.
  for (const path of ["/flipdesk/subscribe", "/flipdesk/change-plan"]) {
    const at = PAYMENTS.indexOf(`paymentRoutes.post("${path}"`);
    if (at === -1) continue; // renamed elsewhere; the cancel guard is the story
    const body = handler(path);
    assert(
      /appstoreSubscriptionBlocksStripe\(user\)/.test(body),
      `${path} lost its App Store guard, so a subscriber could be billed twice`,
    );
  }
});

Deno.test("US-2125 AC4: the web billing page hides Stripe CTAs for in-app plans", () => {
  // The client half of the same rule. It is not the enforcement — the route
  // above is — but a user who is SHOWN a cancel button that 409s has been told
  // the wrong thing before they ever click.
  const billing = Deno.readTextFileSync(
    new URL("../../../../src/pages/billing.tsx", import.meta.url),
  );
  assert(
    /const appstoreManaged = isAppstoreManaged\(subscription\)/.test(billing),
    "the billing page no longer computes whether the plan is App Store managed",
  );
  assert(
    /\{appstoreManaged \?/.test(billing),
    "the billing page no longer branches its subscription CTAs on it",
  );
  assert(
    /Manage this plan in the GradeThread iOS app/.test(billing),
    "the page no longer tells an App Store subscriber where to manage the plan",
  );
});

Deno.test("US-2125 AC4: iOS defers to the platform sheet, not a server cancel", () => {
  // Apple REQUIRES cancellation on-platform. If the iOS app ever posted to the
  // web cancel endpoint instead, it would now receive the 409 above — correct,
  // but the app should never have asked.
  const files = [
    "../../../../ios/GradeThread/Billing/PaywallView.swift",
    "../../../../ios/GradeThread/Settings/PlanSection.swift",
  ];
  let found = 0;
  for (const f of files) {
    let src: string;
    try {
      src = Deno.readTextFileSync(new URL(f, import.meta.url));
    } catch {
      continue; // iOS tree not present in this checkout
    }
    if (/\.manageSubscriptionsSheet\(/.test(src)) found++;
    assert(
      !/flipdesk\/cancel/.test(src),
      `${f} calls the web cancel endpoint — cancellation must stay on-platform`,
    );
  }
  assert(
    found > 0,
    "no iOS surface presents .manageSubscriptionsSheet, so an App Store " +
      "subscriber has nowhere in-app to cancel",
  );
});
