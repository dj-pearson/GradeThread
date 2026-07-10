// US-1825: closet item add — pure input helpers (source guard, text clean, grade
// parse). The ownership-verification + DB paths are covered by tenant-isolation.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isClosetSource, cleanText, parseGrade, CLOSET_SOURCES } = await import(
  "../routes/buyer-closet.ts"
);

Deno.test("isClosetSource accepts only the three sources", () => {
  for (const s of CLOSET_SOURCES) assert(isClosetSource(s));
  assert(!isClosetSource("wishlist"));
  assert(!isClosetSource(""));
  assert(!isClosetSource(null));
});

Deno.test("cleanText trims, empties to null, and caps length", () => {
  assertEquals(cleanText("  Nike  "), "Nike");
  assertEquals(cleanText("   "), null);
  assertEquals(cleanText(42), null);
  assertEquals(cleanText("a".repeat(300), 50)?.length, 50);
});

Deno.test("parseGrade clamps to the 1.0–10.0 scale and rounds to 0.1", () => {
  assertEquals(parseGrade(8.5), 8.5);
  assertEquals(parseGrade("7.25"), 7.3);
  assertEquals(parseGrade(0.5), null); // below scale
  assertEquals(parseGrade(11), null); // above scale
  assertEquals(parseGrade("nope"), null);
  assertEquals(parseGrade(null), null);
});
