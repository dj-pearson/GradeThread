// Unit tests for the per-platform social spec (US-870). Pure module, no env.
//   deno test src/tests/social-platforms_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  buildSocialCardUrl,
  deriveCardText,
  IMAGE_FIELD_RATIO,
  isSocialPlatform,
  normalizeEnabledPlatforms,
  PLATFORM_CHAR_LIMIT,
  PLATFORM_IMAGE_FIELD,
  SOCIAL_PLATFORMS,
} from "../lib/social-platforms.ts";

Deno.test("isSocialPlatform guards the known networks", () => {
  for (const p of SOCIAL_PLATFORMS) assert(isSocialPlatform(p));
  assert(isSocialPlatform("tiktok")); // video-distribution addition
  assert(!isSocialPlatform("snapchat"));
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

// ─── US-871: branded card helpers ──────────────────────────────────────────

Deno.test("every platform's image_field maps to a known card ratio", () => {
  for (const p of SOCIAL_PLATFORMS) {
    const field = PLATFORM_IMAGE_FIELD[p];
    assert(IMAGE_FIELD_RATIO[field], `no ratio for ${field}`);
  }
});

Deno.test("buildSocialCardUrl encodes content into a stateless /og/social/card URL", () => {
  const url = buildSocialCardUrl({
    siteUrl: "https://gradethread.com/",
    ratio: "square",
    kind: "stat",
    text: "Average grade across 10k items",
    stat: "9.2",
    product: "flipdesk",
    eyebrow: "Condition data",
  });
  const u = new URL(url);
  assertEquals(u.pathname, "/og/social/card");
  assertEquals(u.searchParams.get("ratio"), "square");
  assertEquals(u.searchParams.get("kind"), "stat");
  assertEquals(u.searchParams.get("stat"), "9.2");
  assertEquals(u.searchParams.get("product"), "flipdesk");
  assertEquals(u.searchParams.get("eyebrow"), "Condition data");
  assertEquals(u.searchParams.get("text"), "Average grade across 10k items");
});

Deno.test("deriveCardText strips links + hashtags and takes the first sentence", () => {
  assertEquals(
    deriveCardText("Grade your denim today! Read more https://x.co/a #reselling"),
    "Grade your denim today!",
  );
  assertEquals(
    deriveCardText("\n\n  First real line  \nSecond line"),
    "First real line",
  );
  // Empty input falls back to the default.
  assert(deriveCardText("  \n #only #tags").length > 0);
});
