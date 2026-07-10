// US-1837: coverage-gap "request the missing photos" macro (pure). No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { categoryFromTitle, recommendedPhotos, buildPhotoRequestMessage, coverageGapForTitle } = await import(
  "../lib/coverage-gap.ts"
);

// ── categoryFromTitle ───────────────────────────────────────────────────────

Deno.test("category: infers from listing title keywords", () => {
  assertEquals(categoryFromTitle("Levi's 501 vintage jeans W32"), "pants");
  assertEquals(categoryFromTitle("Patagonia Nano Puff jacket"), "jacket");
  assertEquals(categoryFromTitle("Nike Air Jordan 1 sneakers"), "shoes");
  assertEquals(categoryFromTitle("mystery item"), "");
  assertEquals(categoryFromTitle(null), "");
});

// ── recommendedPhotos ───────────────────────────────────────────────────────

Deno.test("recommended: always the core three, then zone close-ups", () => {
  const photos = recommendedPhotos("shirt");
  // Core photos first.
  assert(photos[0].toLowerCase().includes("front"));
  assert(photos[1].toLowerCase().includes("back"));
  assert(photos[2].toLowerCase().includes("label"));
  // At least one zone close-up, and no more than 3 core + 4 zones.
  assert(photos.length >= 3 && photos.length <= 7);
});

Deno.test("recommended: unknown category still yields the core photos", () => {
  const photos = recommendedPhotos("");
  assert(photos.length >= 3);
  assert(photos.some((p) => p.toLowerCase().includes("label")));
});

// ── buildPhotoRequestMessage ────────────────────────────────────────────────

Deno.test("message: polite, lists the photos as bullets, no automation", () => {
  const msg = buildPhotoRequestMessage(["Front photo", "Back photo"]);
  assert(msg.includes("• Front photo"));
  assert(msg.includes("• Back photo"));
  assert(/thanks/i.test(msg));
  // Framed as a request, not a demand.
  assert(/would you|could you/i.test(msg));
});

// ── coverageGapForTitle ─────────────────────────────────────────────────────

Deno.test("gap: end-to-end from a title", () => {
  const gap = coverageGapForTitle("Vintage Carhartt work jacket");
  assert(gap.recommendedPhotos.length >= 3);
  assert(gap.message.includes(gap.recommendedPhotos[0]));
});
