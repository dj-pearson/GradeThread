// US-2634: the composer's Title and Price write themselves on edit. These lock
// the rules that decide WHETHER to write — the half that, when it gets it
// wrong, either hammers the database on every keystroke or silently keeps the
// original value in the row the Google Sheets sync reads.
import { describe, expect, it } from "vitest";
import {
  AUTOSAVE_DELAY_MS,
  parseAutosavePrice,
  shouldAutosavePrice,
  shouldAutosaveTitle,
} from "@/lib/composer-autosave";

function titleInput(over: Partial<Parameters<typeof shouldAutosaveTitle>[0]> = {}) {
  return {
    initialised: true,
    isEbayOrigin: false,
    saving: false,
    title: "Nike Windbreaker Mens Large Navy",
    lastSavedTitle: "Nike Windbreaker",
    ...over,
  };
}

function priceInput(over: Partial<Parameters<typeof shouldAutosavePrice>[0]> = {}) {
  return {
    initialised: true,
    isEbayOrigin: false,
    saving: false,
    price: "48.50",
    lastSavedPrice: 39,
    ...over,
  };
}

describe("shouldAutosaveTitle", () => {
  it("saves an edited title", () => {
    expect(shouldAutosaveTitle(titleInput())).toBe(true);
  });

  it("never saves before the form has been seeded", () => {
    expect(shouldAutosaveTitle(titleInput({ initialised: false }))).toBe(false);
  });

  it("never saves the seeded value back over itself", () => {
    expect(
      shouldAutosaveTitle(
        titleInput({ title: "Nike Windbreaker", lastSavedTitle: "Nike Windbreaker" }),
      ),
    ).toBe(false);
  });

  it("ignores a whitespace-only difference", () => {
    expect(
      shouldAutosaveTitle(
        titleInput({ title: "  Nike Windbreaker  ", lastSavedTitle: "Nike Windbreaker" }),
      ),
    ).toBe(false);
  });

  it("refuses an eBay-originated listing — eBay owns that title", () => {
    expect(shouldAutosaveTitle(titleInput({ isEbayOrigin: true }))).toBe(false);
  });

  it("stands down while an explicit save is in flight", () => {
    expect(shouldAutosaveTitle(titleInput({ saving: true }))).toBe(false);
  });

  it("never writes a blank title over a real one", () => {
    expect(shouldAutosaveTitle(titleInput({ title: "" }))).toBe(false);
    expect(shouldAutosaveTitle(titleInput({ title: "   " }))).toBe(false);
  });

  it("saves the first edit when nothing is known to be persisted", () => {
    expect(shouldAutosaveTitle(titleInput({ lastSavedTitle: null }))).toBe(true);
  });
});

describe("parseAutosavePrice", () => {
  it("takes a plain number", () => {
    expect(parseAutosavePrice("48.50")).toBe(48.5);
    expect(parseAutosavePrice(" 30 ")).toBe(30);
    expect(parseAutosavePrice(".99")).toBe(0.99);
  });

  it("rounds to cents", () => {
    expect(parseAutosavePrice("19.999")).toBe(20);
  });

  it("refuses zero, negatives and blanks", () => {
    expect(parseAutosavePrice("0")).toBeNull();
    expect(parseAutosavePrice("0.00")).toBeNull();
    expect(parseAutosavePrice("-5")).toBeNull();
    expect(parseAutosavePrice("")).toBeNull();
  });

  it("refuses a half-typed number rather than saving what it parses to", () => {
    expect(parseAutosavePrice("12.")).toBeNull();
    expect(parseAutosavePrice("1e3")).toBeNull();
    expect(parseAutosavePrice("48 usd")).toBeNull();
  });
});

describe("shouldAutosavePrice", () => {
  it("saves an edited price", () => {
    expect(shouldAutosavePrice(priceInput())).toBe(true);
  });

  it("does not re-save the same money typed differently", () => {
    // "25.00" is the saved 25 — a string compare would write on every visit.
    expect(
      shouldAutosavePrice(priceInput({ price: "25.00", lastSavedPrice: 25 })),
    ).toBe(false);
  });

  it("saves the first price when the row has none", () => {
    expect(shouldAutosavePrice(priceInput({ lastSavedPrice: null }))).toBe(true);
  });

  it("never writes a cleared box or a zero over a real price", () => {
    expect(shouldAutosavePrice(priceInput({ price: "" }))).toBe(false);
    expect(shouldAutosavePrice(priceInput({ price: "0" }))).toBe(false);
  });

  it("refuses an eBay-originated listing, and stands down mid-save", () => {
    expect(shouldAutosavePrice(priceInput({ isEbayOrigin: true }))).toBe(false);
    expect(shouldAutosavePrice(priceInput({ saving: true }))).toBe(false);
    expect(shouldAutosavePrice(priceInput({ initialised: false }))).toBe(false);
  });
});

describe("AUTOSAVE_DELAY_MS", () => {
  it("waits long enough that typing is not one write per keystroke", () => {
    expect(AUTOSAVE_DELAY_MS).toBeGreaterThanOrEqual(500);
  });
});
