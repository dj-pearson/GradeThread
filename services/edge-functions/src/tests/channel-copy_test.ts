// The title rule every cross-post channel shares (channel-copy.ts). Pure.
//   deno test src/tests/channel-copy_test.ts

import { assertEquals } from "@std/assert";
import {
  channelHasTitle,
  fitTitle,
  readChannelOverrides,
  resolveChannelTitle,
} from "../lib/channel-copy.ts";

const EBAY_TITLE =
  "Cozy Earth Bamboo Jogger Set Sz 3XL Navy Blue Hooded Pullover Lounge Pants";

Deno.test("every channel copies the eBay title, fitted to its own limit", () => {
  // 74 characters: fits Poshmark and Mercari (80), not Grailed or Vinted (60).
  assertEquals(resolveChannelTitle("poshmark", { sharedTitle: EBAY_TITLE }), EBAY_TITLE);
  assertEquals(resolveChannelTitle("mercari", { sharedTitle: EBAY_TITLE }), EBAY_TITLE);
  assertEquals(
    resolveChannelTitle("grailed", { sharedTitle: EBAY_TITLE }),
    "Cozy Earth Bamboo Jogger Set Sz 3XL Navy Blue Hooded",
  );
  assertEquals(
    resolveChannelTitle("vinted", { sharedTitle: EBAY_TITLE }),
    "Cozy Earth Bamboo Jogger Set Sz 3XL Navy Blue Hooded",
  );
});

Deno.test("Depop has no title field and gets none", () => {
  assertEquals(channelHasTitle("depop"), false);
  assertEquals(resolveChannelTitle("depop", { sharedTitle: EBAY_TITLE, override: "x" }), "");
});

Deno.test("an override beats eBay, and the item title is the last resort", () => {
  assertEquals(
    resolveChannelTitle("poshmark", { override: "Mine", sharedTitle: EBAY_TITLE }),
    "Mine",
  );
  assertEquals(
    resolveChannelTitle("poshmark", { override: "  ", sharedTitle: "", itemTitle: "Item" }),
    "Item",
  );
  assertEquals(resolveChannelTitle("poshmark", {}), "");
});

Deno.test("fitTitle never cuts a word in half", () => {
  assertEquals(fitTitle("aaaa bbbb cccc", 11), "aaaa bbbb");
  assertEquals(fitTitle("aaaaaaaaaaaa", 5), "aaaaa", "one long word falls back to a hard cut");
  assertEquals(fitTitle("  short  ", 80), "short");
  assertEquals(fitTitle("unbounded", null), "unbounded");
});

Deno.test("readChannelOverrides ignores anything that is not a non-blank string", () => {
  assertEquals(readChannelOverrides(null), { title: null, description: null });
  assertEquals(readChannelOverrides([]), { title: null, description: null });
  assertEquals(
    readChannelOverrides({ title_override: "", description_override: 4 }),
    { title: null, description: null },
  );
  assertEquals(
    readChannelOverrides({ title_override: "T", description_override: "D", title: "AI" }),
    { title: "T", description: "D" },
  );
});
