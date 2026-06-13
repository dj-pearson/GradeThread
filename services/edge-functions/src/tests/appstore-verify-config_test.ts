// US-788: pure env-handling for the App Store JWS verifier.
import { assertEquals } from "@std/assert";
import {
  parseAppleAppId,
  resolveAppstoreEnvironmentName,
  shouldWarnMissingAppleAppId,
} from "../lib/appstore/verify-config.ts";

Deno.test("parseAppleAppId: unset / blank → undefined (the Number('') === 0 trap)", () => {
  assertEquals(parseAppleAppId(undefined), undefined);
  assertEquals(parseAppleAppId(""), undefined);
  assertEquals(parseAppleAppId("   "), undefined);
});

Deno.test("parseAppleAppId: non-numeric / non-positive → undefined", () => {
  assertEquals(parseAppleAppId("abc"), undefined);
  assertEquals(parseAppleAppId("0"), undefined);
  assertEquals(parseAppleAppId("-5"), undefined);
  assertEquals(parseAppleAppId("NaN"), undefined);
});

Deno.test("parseAppleAppId: a valid numeric Apple ID parses (trimmed)", () => {
  assertEquals(parseAppleAppId("123456789"), 123456789);
  assertEquals(parseAppleAppId("  6789 "), 6789);
});

Deno.test("resolveAppstoreEnvironmentName: only exact 'Sandbox' is Sandbox; else Production", () => {
  assertEquals(resolveAppstoreEnvironmentName("Sandbox"), "Sandbox");
  assertEquals(resolveAppstoreEnvironmentName("  Sandbox  "), "Sandbox");
  assertEquals(resolveAppstoreEnvironmentName("Production"), "Production");
  assertEquals(resolveAppstoreEnvironmentName(undefined), "Production");
  assertEquals(resolveAppstoreEnvironmentName("sandbox"), "Production"); // case-sensitive, fail-safe to strict
});

Deno.test("shouldWarnMissingAppleAppId: only Production + unset Apple ID warns", () => {
  assertEquals(shouldWarnMissingAppleAppId("Production", undefined), true);
  assertEquals(shouldWarnMissingAppleAppId("Production", 123), false);
  assertEquals(shouldWarnMissingAppleAppId("Sandbox", undefined), false);
  assertEquals(shouldWarnMissingAppleAppId("Sandbox", 123), false);
});
