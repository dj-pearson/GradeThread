// The intake form's decisions (intake-plan.ts): which source a save links to,
// the row it writes, and what a seller reads when some photos did not upload.

import { describe, expect, it } from "vitest";
import {
  buildIntakeInsert,
  photoShortfallMessage,
  priceOrNull,
  validatePurchasePrice,
  classifyIntakeSaveError,
  resolveIntakeSource,
  type IntakeFormState,
} from "@/pages/flipdesk/intake-plan";

function form(over: Partial<IntakeFormState> = {}): IntakeFormState {
  return {
    title: "  Wool Overcoat  ",
    sku: "",
    container: " Bin 4 ",
    brand: "",
    style: "",
    size: "",
    color: "",
    material: "",
    item_category: "",
    source_id: "",
    source_new: "",
    sourced_by: "",
    purchase_date: "2026-09-20",
    purchase_price: "",
    description: "",
    condition_notes: "",
    status: "cataloged",
    ...over,
  };
}

const NO_AI = { garment_type: null, garment_category: null };

describe("resolveIntakeSource", () => {
  it("creates a new source from a trimmed name", () => {
    expect(resolveIntakeSource({ source_id: "__new", source_new: "  Estate sale " })).toEqual({
      kind: "new",
      name: "Estate sale",
    });
  });

  it("never creates a source from a blank new name", () => {
    expect(resolveIntakeSource({ source_id: "__new", source_new: "   " })).toEqual({
      kind: "none",
    });
  });

  it("links an existing source and treats none and empty as no source", () => {
    expect(resolveIntakeSource({ source_id: "src-1", source_new: "ignored" })).toEqual({
      kind: "existing",
      id: "src-1",
    });
    expect(resolveIntakeSource({ source_id: "__none", source_new: "" })).toEqual({ kind: "none" });
    expect(resolveIntakeSource({ source_id: "", source_new: "" })).toEqual({ kind: "none" });
  });
});

describe("buildIntakeInsert", () => {
  it("writes the owner, the source and trimmed fields, and nulls the blanks", () => {
    const row = buildIntakeInsert({
      form: form({ purchase_price: " 12.50 " }),
      ownerId: "owner-1",
      sourceId: "src-1",
      aiFields: [],
      aiMeta: {},
      aiGarment: NO_AI,
      measurements: {},
    });
    expect(row).toMatchObject({
      user_id: "owner-1",
      source_id: "src-1",
      title: "Wool Overcoat",
      container: "Bin 4",
      brand: null,
      sku: null,
      acquired_date: "2026-09-20",
      acquired_price: 12.5,
      status: "cataloged",
    });
    expect(typeof row.acquired_date_tz).toBe("string");
    // Nothing AI-filled and nothing measured: the columns are left to their
    // defaults rather than written as empty objects.
    expect(row.measurements).toBeUndefined();
    expect(row.ai_field_sources).toBeUndefined();
    expect(row.ai_enriched_at).toBeUndefined();
  });

  it("derives the garment fields grading needs from the category (US-1423)", () => {
    const row = buildIntakeInsert({
      form: form({ item_category: "shoes" }),
      ownerId: "owner-1",
      sourceId: null,
      aiFields: [],
      aiMeta: {},
      aiGarment: NO_AI,
      measurements: {},
    });
    expect(row.item_category).toBe("shoes");
    expect(row.garment_type).toBe("footwear");
    expect(row.garment_category).toBe("other");
  });

  it("prefers the garment values the AI extractor returned", () => {
    const row = buildIntakeInsert({
      form: form({ item_category: "clothing" }),
      ownerId: "owner-1",
      sourceId: null,
      aiFields: [],
      aiMeta: {},
      aiGarment: { garment_type: "outerwear", garment_category: "coat" },
      measurements: {},
    });
    // clothing alone would default to tops/other.
    expect(row.garment_type).toBe("outerwear");
    expect(row.garment_category).toBe("coat");
  });

  it("records AI provenance for each AI-filled field, and the time it happened", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const row = buildIntakeInsert({
      form: form(),
      ownerId: "owner-1",
      sourceId: null,
      aiFields: new Set(["brand", "size"]),
      aiMeta: { brand: { source: "photo:tag", confidence: 0.9 } },
      aiGarment: NO_AI,
      measurements: {},
      now,
    });
    expect(row.ai_field_sources).toEqual({
      brand: { source: "photo:tag", confidence: 0.9, accepted: true },
      // No meta for size: it still counts, as text with no confidence.
      size: { source: "text", confidence: 0, accepted: true },
    });
    expect(row.ai_enriched_at).toBe(now.toISOString());
  });

  it("writes measurements taken at intake (US-2546 AC4)", () => {
    const row = buildIntakeInsert({
      form: form(),
      ownerId: "owner-1",
      sourceId: null,
      aiFields: [],
      aiMeta: {},
      aiGarment: NO_AI,
      measurements: { chest: 22, length: "29" },
    });
    expect(row.measurements).toEqual({ chest: 22, length: "29" });
  });

  it("stores no zone when there is no purchase day", () => {
    const row = buildIntakeInsert({
      form: form({ purchase_date: "" }),
      ownerId: "owner-1",
      sourceId: null,
      aiFields: [],
      aiMeta: {},
      aiGarment: NO_AI,
      measurements: {},
    });
    expect(row.acquired_date).toBeNull();
    expect(row.acquired_date_tz).toBeNull();
  });
});

describe("priceOrNull", () => {
  it("reads a number and refuses anything else", () => {
    expect(priceOrNull("  4 ")).toBe(4);
    expect(priceOrNull("")).toBeNull();
    expect(priceOrNull("abc")).toBeNull();
  });
});

describe("photoShortfallMessage (US-2546 AC2)", () => {
  it("says nothing when every photo went up", () => {
    expect(photoShortfallMessage(3, 3)).toBeNull();
    expect(photoShortfallMessage(0, 0)).toBeNull();
  });

  it("names how many are missing, and says the item was saved", () => {
    expect(photoShortfallMessage(3, 2)).toBe(
      "Saved the item, but 1 photo didn't upload. Add them from the item page.",
    );
    expect(photoShortfallMessage(4, 1)).toBe(
      "Saved the item, but 3 photos didn't upload. Add them from the item page.",
    );
  });
});

describe("validatePurchasePrice", () => {
  it("rejects negatives, exponent forms and fractions of a cent", () => {
    expect(validatePurchasePrice("-5").ok).toBe(false);
    expect(validatePurchasePrice("1e3").ok).toBe(false);
    expect(validatePurchasePrice("12.345").ok).toBe(false);
    expect(validatePurchasePrice("abc").ok).toBe(false);
  });

  it("accepts blank and plain decimals, rounded to cents", () => {
    expect(validatePurchasePrice("")).toEqual({ ok: true, value: null });
    expect(validatePurchasePrice("12.5")).toEqual({ ok: true, value: 12.5 });
    expect(validatePurchasePrice("$4")).toEqual({ ok: true, value: 4 });
    expect(validatePurchasePrice(".99")).toEqual({ ok: true, value: 0.99 });
    expect(validatePurchasePrice("1,200.10")).toEqual({ ok: true, value: 1200.1 });
  });

  it("priceOrNull no longer passes a negative or an exponent through", () => {
    expect(priceOrNull("-5")).toBeNull();
    expect(priceOrNull("1e3")).toBeNull();
  });
});

describe("classifyIntakeSaveError", () => {
  it("names a SKU clash, a bad price and a source the member may not add", () => {
    expect(
      classifyIntakeSaveError(
        { code: "23505", message: 'duplicate key value violates unique constraint "idx_inventory_items_user_sku"' },
        "insert",
      ),
    ).toEqual({ kind: "sku" });
    expect(
      classifyIntakeSaveError(
        { code: "23514", message: 'new row violates check constraint "inventory_items_acquired_price_nonneg"' },
        "insert",
      ),
    ).toEqual({ kind: "price" });
    expect(classifyIntakeSaveError({ code: "42501", message: "denied" }, "source")).toEqual({
      kind: "source-denied",
    });
    expect(classifyIntakeSaveError({ code: "42501", message: "denied" }, "insert")).toEqual({
      kind: "other",
    });
  });
});
