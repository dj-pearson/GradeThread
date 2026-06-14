// US-901: the admin-search sanitiser strips PostgREST filter / ILIKE
// metacharacters so a search term can't break out of the ilike pattern. Set
// dummy supabase env first (the route module loads supabase at init).
//   deno test --allow-env src/tests/admin-search_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { sanitize } = await import("../routes/admin-search.ts");

Deno.test("strips ILIKE wildcards and PostgREST filter delimiters", () => {
  assertEquals(sanitize("a%b_c"), "a b c");
  assertEquals(sanitize("foo,bar"), "foo bar");
  assertEquals(sanitize("(drop)"), "drop");
  assertEquals(sanitize("a*b\\c"), "a b c");
});

Deno.test("trims surrounding whitespace", () => {
  assertEquals(sanitize("  hello  "), "hello");
});

Deno.test("leaves a clean term untouched", () => {
  assertEquals(sanitize("nike air"), "nike air");
  assertEquals(sanitize("user@example.com"), "user@example.com");
});

Deno.test("a pure-metacharacter term collapses to empty", () => {
  assert(sanitize("%%,()").length === 0);
});
