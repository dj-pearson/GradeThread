import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// US-920: the imagery module statically imports lib/supabase.ts (via ai-usage),
// so set env FIRST then dynamic-import (mirrors newsletter-assembler_test.ts).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("PUBLIC_SITE_URL", "https://gradethread.com");

const {
  buildEmailImageHtml,
  brandedCardUrl,
  resolveImageFromUrl,
  estimateImageTokens,
  EMAIL_IMAGE_DISPLAY_WIDTH,
  BRANDED_CARD_SIZE,
} = await import("../lib/newsletter-imagery.ts");

Deno.test("buildEmailImageHtml is email-safe: bounded width, attrs, alt, bg fallback", () => {
  const html = buildEmailImageHtml({
    url: "https://cdn.example.com/x.png",
    alt: "An editorial photo",
    width: 1536,
    height: 1024,
  });
  // Explicit dimensions bounded to the content column, retina source scaled down.
  assertStringIncludes(html, `width="${EMAIL_IMAGE_DISPLAY_WIDTH}"`);
  // 3:2 source → display height ≈ 536 * (1024/1536) = 357.
  assertStringIncludes(html, `height="357"`);
  assertStringIncludes(html, `max-width:${EMAIL_IMAGE_DISPLAY_WIDTH}px`);
  // Descriptive alt + a brand background so a blocked image still shows context.
  assertStringIncludes(html, `alt="An editorial photo"`);
  assertStringIncludes(html, "background-color:#0F3460");
  assertStringIncludes(html, "display:block");
});

Deno.test("buildEmailImageHtml escapes the url and alt", () => {
  const html = buildEmailImageHtml({
    url: "https://x/y?a=1&b=2",
    alt: 'Tom & "Jerry"',
    width: 1200,
    height: 630,
  });
  assertStringIncludes(html, "a=1&amp;b=2");
  assertStringIncludes(html, "Tom &amp; &quot;Jerry&quot;");
  assert(!html.includes('alt="Tom & "Jerry""'));
});

Deno.test("brandedCardUrl builds an absolute, deterministic Satori card URL", () => {
  const url = brandedCardUrl({ text: "Grade like a pro", eyebrow: "Condition grading", product: "flipdesk" });
  assert(url.startsWith("https://gradethread.com/og/social/card?"));
  const q = new URL(url).searchParams;
  assertEquals(q.get("ratio"), "landscape");
  assertEquals(q.get("kind"), "title");
  assertEquals(q.get("text"), "Grade like a pro");
  assertEquals(q.get("eyebrow"), "Condition grading");
  assertEquals(q.get("product"), "flipdesk");
});

Deno.test("brandedCardUrl honors an explicit siteUrl and trims trailing slashes", () => {
  const url = brandedCardUrl({ text: "Hi", siteUrl: "https://staging.example.com/" });
  assert(url.startsWith("https://staging.example.com/og/social/card?"));
});

Deno.test("resolveImageFromUrl detects a branded card vs a photo by path", () => {
  const card = resolveImageFromUrl("https://gradethread.com/og/social/card?text=Hi", "Hi — GradeThread");
  assertEquals(card.kind, "branded_card");
  assertEquals(card.width, BRANDED_CARD_SIZE.width);
  assertEquals(card.height, BRANDED_CARD_SIZE.height);
  assertStringIncludes(card.html, "<img");

  const hero = resolveImageFromUrl("https://cdn/content-images/blog/abc/newsletter-abc_1.png", "A photo");
  assertEquals(hero.kind, "hero");
  assertEquals(hero.width, 1536);
  assertEquals(hero.height, 1024);
});

Deno.test("estimateImageTokens returns realistic per-size/quality token counts", () => {
  assertEquals(estimateImageTokens("1536x1024", "medium"), 1584);
  assertEquals(estimateImageTokens("1536x1024", "high"), 6240);
  assertEquals(estimateImageTokens("1024x1024", "low"), 272);
  // Unknown quality defaults to medium.
  assertEquals(estimateImageTokens("1024x1024", "ultra"), 1056);
});
