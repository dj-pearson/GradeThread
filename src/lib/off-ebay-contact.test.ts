import { describe, expect, it } from "vitest";
import { describeContact, detectOffEbayContact } from "@/lib/off-ebay-contact";

describe("detectOffEbayContact (OM-09)", () => {
  it("finds an email address", () => {
    expect(detectOffEbayContact("Email me at jane.doe+shop@gmail.com")).toEqual(["email"]);
  });

  it("finds a phone number in the usual shapes", () => {
    for (const t of ["call 555-123-4567", "text (555) 123 4567", "+1 555.123.4567", "5551234567"]) {
      expect(detectOffEbayContact(t), t).toEqual(["phone"]);
    }
  });

  it("finds a link, with or without a scheme", () => {
    expect(detectOffEbayContact("see https://example.org/pics")).toEqual(["link"]);
    expect(detectOffEbayContact("more at www.myshop.net")).toEqual(["link"]);
    expect(detectOffEbayContact("photos on mydenim.com/jacket")).toEqual(["link"]);
  });

  it("does not count an email's domain as a second, link finding", () => {
    expect(detectOffEbayContact("jane@shop.com")).toEqual(["email"]);
  });

  it("leaves eBay's own links, measurements and prices alone", () => {
    expect(detectOffEbayContact("See my other listing at https://www.ebay.com/itm/1234")).toEqual([]);
    expect(detectOffEbayContact("Pit to pit is 22 in, length 30. I can do $45.")).toEqual([]);
    expect(detectOffEbayContact("Thanks! Ships within 1 business day.")).toEqual([]);
  });

  it("names what it found in plain words", () => {
    expect(describeContact(["email", "phone"])).toBe("an email address and a phone number");
    expect(describeContact(["link"])).toBe("a link");
  });
});
