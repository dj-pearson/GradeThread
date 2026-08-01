import "./_env.ts";
import { assertEquals } from "@std/assert";
import { toEbayCarrierCode } from "../lib/ebay-client.ts";

Deno.test("toEbayCarrierCode maps common carriers (case/format-insensitive)", () => {
  assertEquals(toEbayCarrierCode("USPS"), "USPS");
  assertEquals(toEbayCarrierCode("usps"), "USPS");
  assertEquals(toEbayCarrierCode("United States Postal Service"), "USPS");
  assertEquals(toEbayCarrierCode("UPS"), "UPS");
  assertEquals(toEbayCarrierCode("FedEx"), "FedEx");
  assertEquals(toEbayCarrierCode("fed ex"), "FedEx");
  assertEquals(toEbayCarrierCode("Federal Express"), "FedEx");
  assertEquals(toEbayCarrierCode("DHL"), "DHL");
  assertEquals(toEbayCarrierCode("  dhl express  "), "DHL");
});

Deno.test("toEbayCarrierCode falls back to Other for unknown/empty", () => {
  assertEquals(toEbayCarrierCode("OnTrac"), "Other");
  assertEquals(toEbayCarrierCode(""), "Other");
  assertEquals(toEbayCarrierCode("   "), "Other");
  assertEquals(toEbayCarrierCode(null), "Other");
  assertEquals(toEbayCarrierCode(undefined), "Other");
});
