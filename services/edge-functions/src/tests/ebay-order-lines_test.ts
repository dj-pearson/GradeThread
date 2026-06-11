// US-468: multi-quantity / multi-line order helpers — unit count normalization,
// per-unit derivation, and the sale-row selection (dedupe disambiguation +
// legacy adoption) logic.

import { assertEquals } from "@std/assert";
import {
  type ExistingSaleRow,
  normalizeUnitCount,
  perUnitPrice,
  pickSaleRowForLine,
} from "../lib/ebay-order-lines.ts";

// ── unit count ─────────────────────────────────────────────────────────

Deno.test("unit count defaults to 1 for missing/invalid, floors decimals", () => {
  assertEquals(normalizeUnitCount(undefined), 1);
  assertEquals(normalizeUnitCount(null), 1);
  assertEquals(normalizeUnitCount(0), 1);
  assertEquals(normalizeUnitCount(-3), 1);
  assertEquals(normalizeUnitCount(2), 2);
  assertEquals(normalizeUnitCount(3.9), 3);
});

// ── per-unit (display only) ────────────────────────────────────────────

Deno.test("per-unit divides the extended total by quantity", () => {
  // lineItemCost is extended: $30 across 3 units → $10/unit.
  assertEquals(perUnitPrice("30.00", 3), 10);
  assertEquals(perUnitPrice("29.99", 1), 29.99);
  assertEquals(perUnitPrice(null, 2), 0);
  assertEquals(perUnitPrice("0", 2), 0);
});

// ── sale-row selection ─────────────────────────────────────────────────

Deno.test("no existing rows → insert (null)", () => {
  assertEquals(pickSaleRowForLine([], "LI-1"), null);
});

Deno.test("exact line_item_id match wins (idempotent re-sync)", () => {
  const rows: ExistingSaleRow[] = [
    { id: "a", line_item_id: "LI-1" },
    { id: "b", line_item_id: "LI-2" },
  ];
  assertEquals(pickSaleRowForLine(rows, "LI-2")?.id, "b");
});

Deno.test("adopts a single legacy null-id row once, then inserts the next line", () => {
  // First pass: legacy row (no line id) is adopted by line LI-1.
  const legacy: ExistingSaleRow[] = [{ id: "legacy", line_item_id: null }];
  assertEquals(pickSaleRowForLine(legacy, "LI-1")?.id, "legacy");

  // After LI-1 stamped its id on the legacy row, the second line in the same
  // order re-queries and sees only a stamped row → inserts (null).
  const afterStamp: ExistingSaleRow[] = [{ id: "legacy", line_item_id: "LI-1" }];
  assertEquals(pickSaleRowForLine(afterStamp, "LI-2"), null);
});

Deno.test("two distinct lines for the same item don't collapse", () => {
  const rows: ExistingSaleRow[] = [
    { id: "x", line_item_id: "LI-1" },
    { id: "y", line_item_id: "LI-2" },
  ];
  // Each line maps to its own row; a third, new line inserts.
  assertEquals(pickSaleRowForLine(rows, "LI-1")?.id, "x");
  assertEquals(pickSaleRowForLine(rows, "LI-2")?.id, "y");
  assertEquals(pickSaleRowForLine(rows, "LI-3"), null);
});

Deno.test("legacy adoption can be disabled", () => {
  const legacy: ExistingSaleRow[] = [{ id: "legacy", line_item_id: null }];
  assertEquals(
    pickSaleRowForLine(legacy, "LI-1", { adoptLegacy: false }),
    null,
  );
});

Deno.test("empty-id line matches an empty-id row directly", () => {
  const rows: ExistingSaleRow[] = [{ id: "m", line_item_id: "" }];
  assertEquals(pickSaleRowForLine(rows, null)?.id, "m");
});
