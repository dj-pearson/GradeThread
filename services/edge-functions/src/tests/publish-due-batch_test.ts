// US-407: publish-due must claim a SMALL, bounded batch per invocation so the
// run finishes inside the 240s job-lock lease and the cron drains any larger
// backlog over successive ticks. publishBatchLimit() is the bound; it defaults
// small, honors an ops override, and clamps so a misconfigured override can't
// reintroduce an unbounded scan.
//
//   deno test --allow-env src/tests/publish-due-batch_test.ts
import { assert, assertEquals } from "@std/assert";

// flipdesk-ebay.ts imports the service-role supabase client at load, so set
// dummy env BEFORE the dynamic import (same pattern as publish-idempotency_test).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { publishBatchLimit } = await import("../routes/flipdesk-ebay.ts");

Deno.test("publishBatchLimit: defaults to a small, bounded batch", () => {
  Deno.env.delete("PUBLISH_DUE_BATCH_LIMIT");
  const n = publishBatchLimit();
  assertEquals(n, 15);
  // The bound must be small enough that batch × worst-case publish wall-time
  // stays under the 240s lease (10s/publish → 150s < 240s).
  assert(n * 10 < 240, "default batch must finish within the job-lock lease");
});

Deno.test("publishBatchLimit: honors a valid ops override", () => {
  Deno.env.set("PUBLISH_DUE_BATCH_LIMIT", "25");
  assertEquals(publishBatchLimit(), 25);
  Deno.env.delete("PUBLISH_DUE_BATCH_LIMIT");
});

Deno.test("publishBatchLimit: clamps an oversized override to 100", () => {
  Deno.env.set("PUBLISH_DUE_BATCH_LIMIT", "5000");
  assertEquals(publishBatchLimit(), 100);
  Deno.env.delete("PUBLISH_DUE_BATCH_LIMIT");
});

Deno.test("publishBatchLimit: ignores junk/non-positive overrides", () => {
  for (const bad of ["0", "-5", "abc", ""]) {
    Deno.env.set("PUBLISH_DUE_BATCH_LIMIT", bad);
    assertEquals(publishBatchLimit(), 15, `override ${JSON.stringify(bad)} should fall back to default`);
  }
  Deno.env.delete("PUBLISH_DUE_BATCH_LIMIT");
});

Deno.test("publishBatchLimit: floors a fractional override", () => {
  Deno.env.set("PUBLISH_DUE_BATCH_LIMIT", "12.9");
  assertEquals(publishBatchLimit(), 12);
  Deno.env.delete("PUBLISH_DUE_BATCH_LIMIT");
});
