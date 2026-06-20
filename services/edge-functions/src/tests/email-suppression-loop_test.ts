// US-914: the suppression loop's AC6 invariant — a hard-bounce notification
// suppresses the address and the next campaign skips it; a transient bounce does
// NOT suppress and a clean recipient still sends.
//
// The two halves are pure and composable:
//   1. parseSesNotification classifies the SES feedback → the set of addresses
//      to suppress (what applySesFeedback writes to email_suppressions).
//   2. evaluateMarketingSend DROPs a suppressed recipient with reason
//      'suppressed' (the coordinator's gate every campaign send routes through).
// Composing them captures the end-to-end "bounce ⇒ future sends skipped"
// guarantee with no DB, mirroring drip-send-gate_test's pure AC approach.
//
// email-suppression.ts statically imports lib/supabase.ts (throws on unset env)
// → set env FIRST, then dynamic-import.
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_QUIET_HOURS,
  evaluateMarketingSend,
  normalizeQuietHours,
} from "../lib/marketing-frequency.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const { parseSesNotification } = await import("../lib/email-suppression.ts");

// A campaign send to `email`, given the set of suppressed addresses. Mirrors the
// coordinator: it consults the suppression set, then runs the marketing gate.
function campaignDecision(email: string, suppressed: Set<string>) {
  return evaluateMarketingSend({
    source: "weekly_newsletter",
    optedOut: false,
    suppressed: suppressed.has(email.toLowerCase()),
    sentInWindow: 0,
    capPerDay: 5,
    enrolledInDrip: false,
    localHour: 12, // midday → not quiet hours
    quietHours: normalizeQuietHours(DEFAULT_QUIET_HOURS),
    msUntilWindowReset: 3_600_000,
    msUntilQuietEnd: 0,
  });
}

Deno.test("hard-bounce notification suppresses the address; next campaign skips it", () => {
  const addr = "bounced@example.com";

  // Before the bounce, the address is sendable.
  const before = campaignDecision(addr, new Set());
  assertEquals(before.action, "send");

  // SES posts a permanent (hard) bounce.
  const parsed = parseSesNotification({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "Bounced@Example.com" }],
    },
  });
  assert(parsed, "a permanent bounce must yield a suppression decision");
  assertEquals(parsed.reason, "hard_bounce");

  // applySesFeedback would write these to email_suppressions.
  const suppressed = new Set(parsed.emails);
  assert(suppressed.has(addr), "the bounced address must be on the suppression set");

  // The next campaign send to that address is dropped (skipped), not sent.
  const after = campaignDecision(addr, suppressed);
  assertEquals(after.action, "drop");
  assertEquals(after.reason, "suppressed");
});

Deno.test("transient bounce does NOT suppress; the address keeps sending", () => {
  const parsed = parseSesNotification({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Transient",
      bounceSubType: "MailboxFull",
      bouncedRecipients: [{ emailAddress: "temp@example.com" }],
    },
  });
  assertEquals(parsed, null, "a transient bounce must not suppress");

  const decision = campaignDecision("temp@example.com", new Set());
  assertEquals(decision.action, "send");
});

Deno.test("complaint suppresses the address; next campaign skips it", () => {
  const parsed = parseSesNotification({
    notificationType: "Complaint",
    complaint: {
      complaintFeedbackType: "abuse",
      complainedRecipients: [{ emailAddress: "angry@example.com" }],
    },
  });
  assert(parsed);
  assertEquals(parsed.reason, "complaint");

  const decision = campaignDecision("angry@example.com", new Set(parsed.emails));
  assertEquals(decision.action, "drop");
  assertEquals(decision.reason, "suppressed");
});
