// Unit tests for the social publish fan-out planning (US-870).
//
// planSocialFanout is pure, but content-social-publish.ts imports the
// service-role supabase client at module load, so set dummy env BEFORE the
// dynamic import (mirrors jobs-content-watchdog_test).
//
//   deno test --allow-env src/tests/content-social-publish_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planSocialFanout } = await import("../lib/content-social-publish.ts");

const POST = {
  id: "post-1",
  cta_url: "https://gradethread.com/?utm_source=social",
  product_focus: "gradethread" as const,
  long_body: "LONG BODY",
  short_body: "SHORT BODY",
  hashtags: ["reselling"],
};
const TS = "2026-06-13T00:00:00.000Z";

function variant(platform: string, body = `${platform} body`) {
  return {
    platform: platform as never,
    body,
    hashtags: [platform],
    image_field: "card_landscape",
    char_limit: 280,
  };
}

Deno.test("fires one webhook per ENABLED platform that has a variant, in order", () => {
  const payloads = planSocialFanout({
    post: POST,
    enabled: ["x", "linkedin", "facebook", "threads", "pinterest", "instagram"],
    variants: [variant("linkedin"), variant("x")], // insertion order reversed
    timestamp: TS,
    siteUrl: "https://gradethread.com",
  });
  // Canonical order from `enabled`, not variant insertion order.
  assertEquals(payloads.map((p) => p.platform), ["x", "linkedin"]);
  for (const p of payloads) {
    assertEquals(p.event, "social.published");
    assertEquals(p.data.id, "post-1");
    assertEquals(p.data.cta_url, POST.cta_url);
    assert(p.format === undefined); // platform path, not legacy
    assertEquals(p.data.image_field, "card_landscape");
  }
});

Deno.test("US-871: auto-fills a branded card URL when the post has no asset", () => {
  const payloads = planSocialFanout({
    post: POST,
    enabled: ["pinterest"],
    variants: [{
      platform: "pinterest" as never,
      body: "Best way to grade pre-owned denim. #reselling",
      hashtags: ["reselling"],
      image_field: "pin_vertical",
      char_limit: 500,
    }],
    timestamp: TS,
    siteUrl: "https://gradethread.com",
  });
  const url = payloads[0].data.image_url ?? "";
  assert(url.startsWith("https://gradethread.com/og/social/card"));
  assert(url.includes("ratio=pin")); // pin_vertical → pin
  assert(url.includes("product=gradethread"));
  // Hashtags/links are stripped from the derived card text.
  assert(!decodeURIComponent(url).includes("#reselling"));
});

Deno.test("US-871: an uploaded asset overrides the auto card for every platform", () => {
  const asset = "https://cdn.example.com/social/post-1/card_1.png";
  const payloads = planSocialFanout({
    post: { ...POST, asset_image_url: asset },
    enabled: ["x", "pinterest"],
    variants: [variant("x"), variant("pinterest")],
    timestamp: TS,
    siteUrl: "https://gradethread.com",
  });
  for (const p of payloads) assertEquals(p.data.image_url, asset);
});

Deno.test("disabled platforms are excluded even if a variant exists", () => {
  const payloads = planSocialFanout({
    post: POST,
    enabled: ["linkedin"], // x disabled
    variants: [variant("x"), variant("linkedin")],
    timestamp: TS,
  });
  assertEquals(payloads.map((p) => p.platform), ["linkedin"]);
});

Deno.test("empty-bodied variants are skipped", () => {
  const payloads = planSocialFanout({
    post: POST,
    enabled: ["x", "linkedin"],
    variants: [variant("x", "   "), variant("linkedin")],
    timestamp: TS,
  });
  assertEquals(payloads.map((p) => p.platform), ["linkedin"]);
});

Deno.test("falls back to legacy long/short when no usable variants", () => {
  const payloads = planSocialFanout({
    post: POST,
    enabled: ["x", "linkedin"],
    variants: [],
    timestamp: TS,
  });
  assertEquals(payloads.map((p) => p.format), ["long", "short"]);
  assert(payloads.every((p) => p.platform === undefined));
  assertEquals(payloads[0].data.body, "LONG BODY");
  assertEquals(payloads[1].data.body, "SHORT BODY");
  // US-871: even the legacy path ships an auto-filled landscape card.
  assert(
    (payloads[0].data.image_url ?? "").includes("ratio=landscape"),
  );
});

Deno.test("fallback omits an empty body half", () => {
  const payloads = planSocialFanout({
    post: { ...POST, long_body: "" },
    enabled: ["x"],
    variants: [],
    timestamp: TS,
  });
  assertEquals(payloads.map((p) => p.format), ["short"]);
});
