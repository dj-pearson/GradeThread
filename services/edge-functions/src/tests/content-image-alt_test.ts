// Unit tests for the image-SEO helpers (US-876).
// Covers the PURE pieces: alt-text normalization, the deterministic fallback,
// gpt-image size parsing, and the slug-based hero filename stem. The AI path
// (generateHeroAltText) needs ANTHROPIC_API_KEY + a live model, so it's not
// exercised here — it always degrades to buildHeroAltFallback, which IS tested.
//
// Dummy Supabase/Anthropic creds are set defensively because the modules import
// service clients at load time.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeAltText, buildHeroAltFallback, parseImageDimensions } =
  await import("../lib/content-image-alt.ts");
const { heroFilenameStem } = await import("../lib/openai-images.ts");

Deno.test("US-876: normalizeAltText strips lead-in phrases and quotes", () => {
  assertEquals(normalizeAltText('"Photo of a vintage denim jacket"'), "a vintage denim jacket");
  assertEquals(normalizeAltText("Image of folded sweaters"), "folded sweaters");
  assertEquals(normalizeAltText("  An  illustration   of  tags  "), "tags");
});

Deno.test("US-876: normalizeAltText keeps a plain description intact", () => {
  assertEquals(
    normalizeAltText("Vintage Levi's jacket on a wooden hanger"),
    "Vintage Levi's jacket on a wooden hanger",
  );
});

Deno.test("US-876: normalizeAltText caps length on a word boundary", () => {
  const long = "word ".repeat(60).trim();
  const out = normalizeAltText(long, 50);
  assert(out.length <= 50);
  assert(!out.endsWith(" "));
});

Deno.test("US-876: buildHeroAltFallback is always non-empty + uses the title", () => {
  assertEquals(
    buildHeroAltFallback("How to Grade Denim"),
    "Hero illustration for How to Grade Denim",
  );
  assertEquals(
    buildHeroAltFallback(null, "thrift flipping"),
    "Hero illustration about thrift flipping",
  );
  assert(buildHeroAltFallback(null, null).length > 0);
  assert(buildHeroAltFallback("", "").length > 0);
});

Deno.test("US-876: parseImageDimensions parses gpt-image size tokens", () => {
  assertEquals(parseImageDimensions("1536x1024"), { width: 1536, height: 1024 });
  assertEquals(parseImageDimensions("1024×1536"), { width: 1024, height: 1536 });
  assertEquals(parseImageDimensions("nonsense"), { width: null, height: null });
  assertEquals(parseImageDimensions(null), { width: null, height: null });
});

Deno.test("US-876: heroFilenameStem builds a slug-based, safe stem", () => {
  assertEquals(heroFilenameStem("how-to-grade-denim"), "how-to-grade-denim-hero");
  assertEquals(heroFilenameStem("How To Grade Denim!!"), "how-to-grade-denim-hero");
  assertEquals(heroFilenameStem(""), "hero");
  assertEquals(heroFilenameStem(null), "hero");
});
