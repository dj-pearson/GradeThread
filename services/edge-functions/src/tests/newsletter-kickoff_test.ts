// US-923: kickoff cadence gate + webhook signing. newsletter-webhook.ts imports
// supabase.ts (throws at init without env), so set dummy creds + dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { kickoffDue, signNewsletterBody } = await import("../lib/newsletter-webhook.ts");

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-20T12:00:00Z");

Deno.test("kickoffDue: never created → due", () => {
  assertEquals(kickoffDue(null, 7, NOW), true);
});

Deno.test("kickoffDue: created inside the cadence period → not due (re-trigger no-op)", () => {
  assertEquals(kickoffDue(NOW - 2 * DAY, 7, NOW), false);
});

Deno.test("kickoffDue: created at/after the cadence period → due", () => {
  assertEquals(kickoffDue(NOW - 7 * DAY, 7, NOW), true);
  assertEquals(kickoffDue(NOW - 8 * DAY, 7, NOW), true);
});

Deno.test("kickoffDue: zero cadence is always due (every tick creates)", () => {
  assertEquals(kickoffDue(NOW - 1, 0, NOW), true);
});

Deno.test("signNewsletterBody: null when no secret configured", async () => {
  Deno.env.delete("NEWSLETTER_WEBHOOK_SIGNING_SECRET");
  assertEquals(await signNewsletterBody('{"event":"issue.created"}'), null);
});

Deno.test("signNewsletterBody: deterministic 64-hex HMAC when secret is set", async () => {
  Deno.env.set("NEWSLETTER_WEBHOOK_SIGNING_SECRET", "test-secret");
  const body = '{"event":"issue.sent","data":{"id":"abc"}}';
  const a = await signNewsletterBody(body);
  const b = await signNewsletterBody(body);
  assert(a !== null);
  assertEquals(a, b);
  assert(/^[0-9a-f]{64}$/.test(a!), `expected 64-hex signature, got ${a}`);
  Deno.env.delete("NEWSLETTER_WEBHOOK_SIGNING_SECRET");
});
