// US-1057: the SES suppression POLICY must hard-suppress permanent bounces and
// complaints while leaving transient bounces alone. parseSesNotification is the
// pure decision function the SNS feedback route + applySesFeedback rely on, so
// pin its behavior here (no DB needed).
//
// email-suppression.ts statically imports lib/supabase.ts (supabaseAdmin), which
// throws "SUPABASE_URL is not set" at import time — so set the env FIRST, then
// dynamic-import the module (a static top-of-file import would run too early).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const { parseSesNotification, normalizeEmail } = await import("../lib/email-suppression.ts");

Deno.test("permanent (hard) bounce suppresses its recipients", () => {
  const result = parseSesNotification({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "Hard.Bounce@Example.com" }],
    },
  });
  assert(result, "expected a suppression decision for a permanent bounce");
  assertEquals(result.reason, "hard_bounce");
  // Recipients are normalized (lowercased/trimmed).
  assertEquals(result.emails, ["hard.bounce@example.com"]);
  assertEquals(result.detail, "Permanent/General");
});

Deno.test("transient bounce does NOT suppress (the address can recover)", () => {
  const result = parseSesNotification({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Transient",
      bounceSubType: "MailboxFull",
      bouncedRecipients: [{ emailAddress: "temp@example.com" }],
    },
  });
  assertEquals(result, null);
});

Deno.test("complaint suppresses its recipients", () => {
  const result = parseSesNotification({
    notificationType: "Complaint",
    complaint: {
      complaintFeedbackType: "abuse",
      complainedRecipients: [{ emailAddress: "angry@example.com" }],
    },
  });
  assert(result, "expected a suppression decision for a complaint");
  assertEquals(result.reason, "complaint");
  assertEquals(result.emails, ["angry@example.com"]);
  assertEquals(result.detail, "abuse");
});

Deno.test("delivery notifications and malformed payloads are ignored", () => {
  assertEquals(parseSesNotification({ notificationType: "Delivery" }), null);
  assertEquals(parseSesNotification(null), null);
  assertEquals(parseSesNotification("nope"), null);
  // Permanent bounce with no recipients → nothing to suppress.
  assertEquals(
    parseSesNotification({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bouncedRecipients: [] },
    }),
    null,
  );
});

Deno.test("the SES event-publishing flavor (eventType) is also honored", () => {
  const result = parseSesNotification({
    eventType: "Complaint",
    complaint: { complainedRecipients: [{ emailAddress: "x@y.com" }] },
  });
  assert(result);
  assertEquals(result.reason, "complaint");
});

Deno.test("normalizeEmail trims and lowercases", () => {
  assertEquals(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
});
