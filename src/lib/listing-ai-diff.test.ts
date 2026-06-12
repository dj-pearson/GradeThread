import { describe, expect, it } from "vitest";
import {
  aiAspect,
  aiPriceInput,
  conditionLabel,
  formatAiPrice,
  normalizeText,
  priceChanged,
  textChanged,
} from "./listing-ai-diff";

describe("normalizeText", () => {
  it("treats null/undefined/whitespace as empty", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("  ")).toBe("");
    expect(normalizeText("  hi ")).toBe("hi");
  });
});

describe("textChanged", () => {
  it("is false when the AI value is empty (nothing to diff)", () => {
    expect(textChanged(null, "anything")).toBe(false);
    expect(textChanged("", "anything")).toBe(false);
  });

  it("is false when current matches the AI value (trim-insensitive)", () => {
    expect(textChanged("Levi's", "Levi's")).toBe(false);
    expect(textChanged("Levi's", "  Levi's  ")).toBe(false);
  });

  it("is true when the seller edited away from the AI value", () => {
    expect(textChanged("Levi's", "Wrangler")).toBe(true);
    expect(textChanged("Used", "")).toBe(true);
  });
});

describe("priceChanged", () => {
  it("is false with no AI price", () => {
    expect(priceChanged(null, "38")).toBe(false);
  });

  it("ignores formatting differences", () => {
    expect(priceChanged(4200, "42")).toBe(false);
    expect(priceChanged(4200, "42.00")).toBe(false);
  });

  it("is true on a real price edit or a blanked input", () => {
    expect(priceChanged(4200, "38")).toBe(true);
    expect(priceChanged(4200, "")).toBe(true);
  });
});

describe("formatAiPrice / aiPriceInput", () => {
  it("formats cents for display", () => {
    expect(formatAiPrice(4200)).toBe("$42");
    expect(formatAiPrice(3850)).toBe("$38.50");
    expect(formatAiPrice(null)).toBe("—");
  });

  it("produces a dollar input string for revert", () => {
    expect(aiPriceInput(4200)).toBe("42");
    expect(aiPriceInput(3850)).toBe("38.5");
    expect(aiPriceInput(null)).toBe("");
  });
});

describe("conditionLabel", () => {
  it("falls back to the raw value when unmapped, and dash when empty", () => {
    expect(conditionLabel(null)).toBe("—");
    expect(conditionLabel("not-a-real-condition")).toBe("not-a-real-condition");
  });
});

describe("aiAspect", () => {
  const snap = { item_specifics: { Brand: ["Nike"], Size: [] } };
  it("returns the first value or empty", () => {
    expect(aiAspect(snap, "Brand")).toBe("Nike");
    expect(aiAspect(snap, "Size")).toBe("");
    expect(aiAspect(snap, "Color")).toBe("");
    expect(aiAspect(null, "Brand")).toBe("");
  });
});
