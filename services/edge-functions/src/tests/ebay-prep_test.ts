// US-826: one-call eBay prep persistence decisions. Covers the pure mapping
// from a prep outcome to the inventory_items column patch (`buildEbayPrepUpdate`)
// — in particular that a PARTIAL prep (category resolved, aspects NOT filled)
// persists the category AND flags the item for a deterministic, non-AI refill,
// while a full / no-specs prep clears the flag. Pure — no Supabase/Anthropic, so
// no env setup is needed.
//   deno test src/tests/ebay-prep_test.ts
import { assertEquals } from "@std/assert";
import {
  buildEbayPrepUpdate,
  isPartialEbayPrep,
} from "../lib/ebay-prep.ts";

Deno.test("filled prep persists merged aspects + timestamp and clears the flag", () => {
  const update = buildEbayPrepUpdate({
    categoryId: "57988",
    status: "filled",
    mergedAspects: { Brand: ["Levi's"], Color: ["Blue"] },
    now: "2026-06-20T00:00:00.000Z",
  });
  assertEquals(update, {
    ebay_category_id: "57988",
    ebay_aspects: { Brand: ["Levi's"], Color: ["Blue"] },
    ai_generated_aspects_at: "2026-06-20T00:00:00.000Z",
    ebay_aspects_refill_needed: false,
  });
});

Deno.test("no-specs prep persists category only and clears the flag (complete)", () => {
  const update = buildEbayPrepUpdate({ categoryId: "57988", status: "no_specs" });
  assertEquals(update, {
    ebay_category_id: "57988",
    ebay_aspects_refill_needed: false,
  });
  // Never writes empty aspects over an existing map for a no-op category.
  assertEquals("ebay_aspects" in update, false);
});

Deno.test("budget-exhausted prep persists category + FLAGS for deterministic refill", () => {
  const update = buildEbayPrepUpdate({
    categoryId: "57988",
    status: "budget_exhausted",
  });
  assertEquals(update, {
    ebay_category_id: "57988",
    ebay_aspects_refill_needed: true,
  });
  // Crucially: aspects are NOT touched — the partial result survives untouched
  // until the deterministic refill fills them.
  assertEquals("ebay_aspects" in update, false);
  assertEquals("ai_generated_aspects_at" in update, false);
});

Deno.test("extraction-failure prep persists category + FLAGS for deterministic refill", () => {
  const update = buildEbayPrepUpdate({
    categoryId: "11484",
    status: "extraction_failed",
  });
  assertEquals(update, {
    ebay_category_id: "11484",
    ebay_aspects_refill_needed: true,
  });
});

Deno.test("isPartialEbayPrep is true ONLY for the deferred-aspects outcomes", () => {
  assertEquals(isPartialEbayPrep("budget_exhausted"), true);
  assertEquals(isPartialEbayPrep("extraction_failed"), true);
  assertEquals(isPartialEbayPrep("filled"), false);
  assertEquals(isPartialEbayPrep("no_specs"), false);
});
