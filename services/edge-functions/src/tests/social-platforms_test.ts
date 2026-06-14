// Unit tests for the per-platform social spec (US-870). Pure module, no env.
//   deno test src/tests/social-platforms_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  isSocialPlatform,
  normalizeEnabledPlatforms,
  PLATFORM_CHAR_LIMIT,
  SOCIAL_PLATFORMS,
} from "../lib/social-platforms.ts";

Deno.test("isSocialPlatform guards the six known networks", () => {
  for (const p of SOCIAL_PLATFORMS) assert(isSocialPlatform(p));
  assert(!isSocialPlatform("tiktok"));
  assert(!isSocialPlatform(42));
  assert(!isSocialPlatform(null));
});

Deno.test("normalizeEnabledPlatforms keeps valid platforms in canonical order", () => {
  // Out-of-order, with a junk entry — junk dropped, order canonicalized.
  assertEquals(
    normalizeEnabledPlatforms(["linkedin", "x", "nope", "instagram"]),
    ["x", "linkedin", "instagram"],
  );
});

Deno.test("normalizeEnabledPlatforms falls back to all six on empty/invalid", () => {
  assertEquals(normalizeEnabledPlatforms([]), [...SOCIAL_PLATFORMS]);
  assertEquals(normalizeEnabledPlatforms(["bogus"]), [...SOCIAL_PLATFORMS]);
  assertEquals(normalizeEnabledPlatforms(null), [...SOCIAL_PLATFORMS]);
  assertEquals(normalizeEnabledPlatforms(undefined), [...SOCIAL_PLATFORMS]);
});

Deno.test("every platform has a positive character limit", () => {
  for (const p of SOCIAL_PLATFORMS) assert(PLATFORM_CHAR_LIMIT[p] > 0);
  assertEquals(PLATFORM_CHAR_LIMIT.x, 280);
});
