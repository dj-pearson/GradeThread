// US-1836: point-of-purchase fraud flags — coarse, buyer-safe (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { deriveFraudFlags } = await import("../lib/fraud-flags.ts");

Deno.test("flags: clean or absent signal → no flags", () => {
  assertEquals(deriveFraudFlags(null), []);
  assertEquals(
    deriveFraudFlags({ manipulation_suspected: false, manipulation_confidence: 0, screenshot_or_watermark_detected: false }),
    [],
  );
});

Deno.test("flags: manipulation only fires at meaningful confidence", () => {
  // suspected but low confidence → no flag (over-flagging is legally worse).
  assertEquals(
    deriveFraudFlags({ manipulation_suspected: true, manipulation_confidence: 0.4, screenshot_or_watermark_detected: false }),
    [],
  );
  const flags = deriveFraudFlags({ manipulation_suspected: true, manipulation_confidence: 0.8, screenshot_or_watermark_detected: false });
  assertEquals(flags.length, 1);
  assertEquals(flags[0].code, "possible_edited_photos");
  assertEquals(flags[0].severity, "warn");
});

Deno.test("flags: screenshot/watermark reuse flag", () => {
  const flags = deriveFraudFlags({ manipulation_suspected: false, manipulation_confidence: 0, screenshot_or_watermark_detected: true });
  assertEquals(flags.map((f) => f.code), ["possible_reused_photos"]);
});

Deno.test("flags: both signals → both flags", () => {
  const flags = deriveFraudFlags({ manipulation_suspected: true, manipulation_confidence: 0.9, screenshot_or_watermark_detected: true });
  assertEquals(flags.map((f) => f.code).sort(), ["possible_edited_photos", "possible_reused_photos"]);
});

Deno.test("flags: copy is risk-FRAMED (possible / ask), never an accusation", () => {
  const flags = deriveFraudFlags({ manipulation_suspected: true, manipulation_confidence: 0.9, screenshot_or_watermark_detected: true });
  for (const f of flags) {
    // No absolute claims ("is fake", "counterfeit", "stolen") — only hedged signals.
    assertEquals(/\bpossible|may be\b/i.test(f.label), true);
    assertEquals(/\bfake|counterfeit|stolen|fraud\b/i.test(f.label), false);
  }
});
