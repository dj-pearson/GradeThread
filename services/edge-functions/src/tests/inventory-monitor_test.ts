// US-1056: low-stock / stockout crossing logic.
//
// inventory-monitor.ts imports system-settings.ts / notify.ts which pull in the
// service-role supabase client at init, so set dummy env BEFORE the dynamic
// import (per the LEARNINGS playbook). The pure crossing functions need no DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { classifyStockLevel, stockTransition } = await import(
  "../lib/inventory-monitor.ts"
);

Deno.test("classifyStockLevel buckets by threshold", () => {
  // threshold 1: only 1 unit (or fewer >0) is low; 0 is stockout.
  assertEquals(classifyStockLevel(5, 1), "ok");
  assertEquals(classifyStockLevel(2, 1), "ok");
  assertEquals(classifyStockLevel(1, 1), "low_stock");
  assertEquals(classifyStockLevel(0, 1), "stockout");
  // higher threshold warns earlier.
  assertEquals(classifyStockLevel(3, 3), "low_stock");
  assertEquals(classifyStockLevel(4, 3), "ok");
  // negative / non-finite treated as stockout.
  assertEquals(classifyStockLevel(-2, 1), "stockout");
  assertEquals(classifyStockLevel(Number.NaN, 1), "stockout");
});

Deno.test("stockTransition fires only on a downward crossing into a worse level", () => {
  // ok → low_stock fires low_stock.
  assertEquals(stockTransition(5, 1, 1), "low_stock");
  // low_stock → stockout fires stockout.
  assertEquals(stockTransition(1, 0, 1), "stockout");
  // ok → stockout fires stockout (skips a level).
  assertEquals(stockTransition(5, 0, 1), "stockout");
});

Deno.test("stockTransition does not re-fire on a steady-state low quantity", () => {
  // Already low, still low → no alert.
  assertEquals(stockTransition(1, 1, 1), null);
  // Already out, still out → no alert.
  assertEquals(stockTransition(0, 0, 1), null);
  // Restock back to ok → no alert (we only warn on the way down).
  assertEquals(stockTransition(0, 5, 1), null);
  // Still healthy → no alert.
  assertEquals(stockTransition(10, 8, 1), null);
});

Deno.test("stockTransition treats a null prevQty as a fresh observation", () => {
  // No prior known quantity, now low → alert.
  assertEquals(stockTransition(null, 1, 1), "low_stock");
  assertEquals(stockTransition(null, 0, 1), "stockout");
  // No prior, still healthy → nothing.
  assertEquals(stockTransition(null, 9, 1), null);
});
