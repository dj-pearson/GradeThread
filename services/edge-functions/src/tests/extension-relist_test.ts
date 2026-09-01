// US-9203: the pure rules of an extension-channel relist.
//
//   deno test --allow-read src/tests/extension-relist_test.ts

// Loads the test env before anything can reach lib/supabase.ts at import
// time (US-2379); without it this file only passes when another ran first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  EXTENSION_RELIST_PLATFORMS,
  isExtensionRelistPlatform,
  relistEligibility,
  relistPayloadFor,
  type RelistSourceRow,
} from "../lib/extension-relist.ts";
import { EXTENSION_DELIST_PLATFORMS } from "../lib/cross-listing-sale.ts";
import { EXTENSION_QUEUE_KINDS } from "../lib/extension-queue.ts";

const URL = "https://poshmark.com/listing/x-5f1e2d3c4b5a69788796a5b4";
const live: RelistSourceRow = {
  id: "L1",
  inventory_item_id: "I1",
  platform: "poshmark",
  listing_status: "active",
  listing_url: URL,
  listing_title: "Tee",
  listing_description: "Soft",
  listing_price: 24,
  draft_id: "G1",
  platform_fields: null,
};

Deno.test("the relist platforms are the delist platforms, derived", () => {
  assertEquals([...EXTENSION_RELIST_PLATFORMS].sort(), [...EXTENSION_DELIST_PLATFORMS].sort());
  assert(isExtensionRelistPlatform("mercari"));
  assert(!isExtensionRelistPlatform("ebay"), "eBay relists under its offer, never by copying");
  assert((EXTENSION_QUEUE_KINDS as readonly string[]).includes("relist"), "the phone can queue one");
});

Deno.test("eligibility: live or ended extension rows with a URL, not yet relisted", () => {
  assertEquals(relistEligibility(live), { ok: true });
  assertEquals(relistEligibility({ ...live, listing_status: "ended" }), { ok: true });
  const ebay = relistEligibility({ ...live, platform: "ebay" });
  assert(!ebay.ok && /not an extension channel/.test(ebay.reason));
  const noItem = relistEligibility({ ...live, inventory_item_id: null });
  assert(!noItem.ok && /inventory item/.test(noItem.reason));
  const noUrl = relistEligibility({ ...live, listing_url: null });
  assert(!noUrl.ok && /nothing to copy from/.test(noUrl.reason));
  const draft = relistEligibility({ ...live, listing_status: "draft" });
  assert(!draft.ok && /live or ended/.test(draft.reason));
  const sold = relistEligibility({ ...live, listing_status: "sold" });
  assert(!sold.ok);
  const done = relistEligibility({ ...live, platform_fields: { relisted_to: "L2" } });
  assert(!done.ok && /already relisted/.test(done.reason));
});

Deno.test("the payload names the OLD listing to copy from and the NEW row to confirm", () => {
  const p = relistPayloadFor(live, "L2");
  assertEquals(p, {
    platform: "poshmark",
    listingUrl: URL,
    listingId: "L1",
    newListingId: "L2",
    itemId: "I1",
    title: "Tee",
    description: "Soft",
    price: 24,
  });
  assertEquals(
    Object.keys(p).sort(),
    ["description", "itemId", "listingId", "listingUrl", "newListingId", "platform", "price", "title"],
    "nothing but the instruction: no credential-shaped key can ride here",
  );
});
