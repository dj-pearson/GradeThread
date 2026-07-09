// US-1803 (phase C): buyer digest cron — the once-per-period idempotency key.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { digestDedupeKey } = await import("../routes/jobs-buyer-digest.ts");

Deno.test("digestDedupeKey: distinct per frequency + period, stable within a period", () => {
  assertEquals(digestDedupeKey("daily", "2026-07-09"), "digest:daily:2026-07-09");
  assertEquals(digestDedupeKey("weekly", "2026-07-06"), "digest:weekly:2026-07-06");
  // Same inputs → same key (idempotent claim within the period).
  assertEquals(digestDedupeKey("daily", "2026-07-09"), digestDedupeKey("daily", "2026-07-09"));
  // Different period → different key.
  assertEquals(digestDedupeKey("daily", "2026-07-09") === digestDedupeKey("daily", "2026-07-10"), false);
});
