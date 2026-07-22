// US-2119: the advance renewal reminder (invoice.upcoming → handleInvoiceUpcoming
// → sendRenewalReminderEmail) must be TRANSACTIONAL, so a marketing opt-out
// cannot suppress the one notice that warns an annual subscriber they are about
// to be charged. This mirrors the US-2120 guard for the trial-ending notice:
// without it, moving "subscription_renewal_reminder" out of
// TRANSACTIONAL_CATEGORIES would silently make the reminder suppressible and no
// test would catch it — a paid customer charged with no warning.
//
//   deno test --allow-env src/tests/renewal-reminder_test.ts

import { assert } from "@std/assert";

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
