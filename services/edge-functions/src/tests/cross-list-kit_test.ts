// 2026-09-02: the cross-list copy kit is filled with every AutoLister draft.
//
// kitPlatformsForSeller decides WHICH channels a seller's draft gets copy for,
// from flipdesk_settings.cross_post_channels. The web rule it mirrors lives in
// src/lib/cross-post-channels.ts: an empty selection means ALL, never none.
// The one place the two differ is deliberate and pinned here: a selection that
// names only API channels gives the web kit its full fallback list (a card with
// no tabs is worse than a card with five) and gives the BATCH nothing, because
// those five were switched off on purpose.
//
//   deno test --allow-env --allow-read --allow-net src/tests/cross-list-kit_test.ts
import "./_env.ts"; // cross-list-kit reaches lib/supabase.ts through ai-listing
import { assert, assertEquals } from "@std/assert";
import { KIT_PLATFORMS, kitPlatformsForSeller } from "../lib/cross-list-kit.ts";
import {
  getDefaultModel,
  getLightweightModel,
  getPlatformVariantModel,
} from "../lib/ai-config.ts";
import { styleFromSpecifics } from "../lib/platform-variants.ts";

Deno.test("null -> every copy-paste channel (the picker stores 'all ticked' as null)", () => {
  // US-3046 read null as "never chosen" for one day. normalizeSelection writes
  // null when every channel is ticked, so a seller who chose all five and one
  // who never opened the page are the same row; the batch writes the kit.
  assertEquals(kitPlatformsForSeller(null), [...KIT_PLATFORMS]);
  assertEquals(kitPlatformsForSeller(undefined), [...KIT_PLATFORMS]);
});

Deno.test("unticked everything ([]) -> every copy-paste channel (the web rule)", () => {
  assertEquals(kitPlatformsForSeller([]), [...KIT_PLATFORMS]);
});

Deno.test("a selection narrows, in kit tab order, not selection order", () => {
  assertEquals(kitPlatformsForSeller(["vinted", "poshmark"]), [
    "poshmark",
    "vinted",
  ]);
});

Deno.test("API-only selection (eBay + Shopify) -> nothing to generate", () => {
  // The web kit falls back to the full list here so it never renders empty.
  // The batch does not: nobody asked for these five, and each one is paid for.
  assertEquals(kitPlatformsForSeller(["ebay", "shopify"]), []);
});

Deno.test("channels the kit does not cover are ignored, not generated", () => {
  // Facebook's lister flow is "verifying" and has no tab; Etsy/Whatnot push
  // through adapters. A selection naming them yields only the kit channels.
  assertEquals(kitPlatformsForSeller(["facebook", "mercari", "etsy"]), [
    "mercari",
  ]);
});

Deno.test("the kit list is the web kit's list, in the web kit's order", () => {
  // listing-kit.tsx KIT_PLATFORMS. If a channel joins one side it must join
  // the other, or a seller sees a tab the batch never fills (or the reverse).
  assertEquals([...KIT_PLATFORMS], [
    "poshmark",
    "mercari",
    "depop",
    "grailed",
    "vinted",
  ]);
});

// ── The platform text pass runs on the lightweight tier ──────────────────────

Deno.test("the platform-variant pass defaults to the lightweight model", () => {
  const before = Deno.env.get("PLATFORM_VARIANT_AI_MODEL");
  Deno.env.delete("PLATFORM_VARIANT_AI_MODEL");
  try {
    assertEquals(getPlatformVariantModel(), getLightweightModel());
    assert(
      getPlatformVariantModel() !== getDefaultModel(),
      "the kit pass is text-only with pinned facts; it must not run on the vision-tier default",
    );
  } finally {
    if (before === undefined) Deno.env.delete("PLATFORM_VARIANT_AI_MODEL");
    else Deno.env.set("PLATFORM_VARIANT_AI_MODEL", before);
  }
});

Deno.test("PLATFORM_VARIANT_AI_MODEL overrides the kit pass alone", () => {
  const before = Deno.env.get("PLATFORM_VARIANT_AI_MODEL");
  Deno.env.set("PLATFORM_VARIANT_AI_MODEL", "claude-test-override");
  try {
    assertEquals(getPlatformVariantModel(), "claude-test-override");
    assert(getLightweightModel() !== "claude-test-override");
  } finally {
    if (before === undefined) Deno.env.delete("PLATFORM_VARIANT_AI_MODEL");
    else Deno.env.set("PLATFORM_VARIANT_AI_MODEL", before);
  }
});

// ── Depop's style field has a source now ─────────────────────────────────────

Deno.test("styleFromSpecifics reads the eBay Style specific, case-insensitively", () => {
  assertEquals(
    styleFromSpecifics({ Brand: ["Nike"], Style: ["Athletic"] }),
    "Athletic",
  );
  assertEquals(styleFromSpecifics({ style: [" Streetwear "] }), "Streetwear");
  assertEquals(styleFromSpecifics({ Style: ["", "Y2K"] }), "Y2K");
});

Deno.test("styleFromSpecifics is null when there is no Style, not a guess", () => {
  assertEquals(styleFromSpecifics({ Brand: ["Nike"], Type: ["Tank"] }), null);
  assertEquals(styleFromSpecifics({ Style: [] }), null);
  assertEquals(styleFromSpecifics(null), null);
});
