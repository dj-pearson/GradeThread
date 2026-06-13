// Unit tests for the blog hero-image pipeline (US-853).
// Covers the pure prompt-resolution precedence and the shared-config image
// model reader. The network/storage path (generateHeroImage/uploadHeroImage)
// is not exercised here — it requires OPENAI_API_KEY + a live bucket.
//
// Dummy Supabase creds are set defensively because openai-images.ts imports
// the service-role client at module load.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveHeroPrompt } = await import("../lib/openai-images.ts");
const { getDefaultImageModel } = await import("../lib/ai-config.ts");

Deno.test("US-853: explicit override wins over everything", () => {
  const prompt = resolveHeroPrompt(
    { hero_prompt: "stored prompt", title: "A Title" },
    "  override prompt  ",
  );
  assertEquals(prompt, "override prompt");
});

Deno.test("US-853: stored hero_prompt wins over the title fallback", () => {
  const prompt = resolveHeroPrompt({ hero_prompt: "  stored prompt  ", title: "A Title" });
  assertEquals(prompt, "stored prompt");
});

Deno.test("US-853: falls back to a title-based prompt", () => {
  const prompt = resolveHeroPrompt({ hero_prompt: "   ", title: "How to Grade Denim" });
  assert(prompt.includes("How to Grade Denim"));
  assert(prompt.toLowerCase().includes("no text in the image"));
});

Deno.test("US-853: generic fallback when nothing is available", () => {
  const prompt = resolveHeroPrompt({ hero_prompt: null, title: null });
  assert(prompt.length > 0);
  assert(prompt.toLowerCase().includes("no text in the image"));
});

Deno.test("US-853: image model defaults to gpt-image-1 and is overridable", () => {
  Deno.env.delete("DEFAULT_IMAGE_MODEL");
  assertEquals(getDefaultImageModel(), "gpt-image-1");

  Deno.env.set("DEFAULT_IMAGE_MODEL", "  gpt-image-2  ");
  assertEquals(getDefaultImageModel(), "gpt-image-2");
  Deno.env.delete("DEFAULT_IMAGE_MODEL");
});
