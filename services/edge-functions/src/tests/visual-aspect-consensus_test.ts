// US-2766: learning from what similar listings DECLARE, never from what they
// are called.
//
// The tests that matter here are the refusals. This module exists because the
// style-code index already tried the easy version - mine the titles - and it
// had to be deleted and the rows deleted with it. The rules below are what
// replaced it, and each one is a case where saying nothing is the right answer.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import type { BrowseComp } from "../lib/ebay-client.ts";
import type { ListingAspects } from "../lib/style-code-aspects.ts";
import {
  gatherVisualAspectEvidence,
  MAX_ASPECT_READS,
  tallyAspect,
} from "../lib/visual-aspect-consensus.ts";

function comp(itemId: string, title = "a listing"): BrowseComp {
  return {
    itemId,
    title,
    price: 40,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: null,
    condition: "Pre-owned",
    buyingOptions: [],
    // US-3098: fixtures state it explicitly; null means 'this source
    // cannot say', which is not the same fact as free shipping.
    shippingCents: null,
    categories: [],
    leafCategoryIds: [],
  };
}

/** A fake Browse aspect read backed by a fixture map. */
function fakeFetch(
  byId: Record<string, Record<string, string>>,
  opts: { fail?: Set<string>; throwOn?: Set<string>; seen?: string[] } = {},
) {
  return (itemId: string): Promise<ListingAspects | null> => {
    opts.seen?.push(itemId);
    if (opts.throwOn?.has(itemId)) throw new Error("eBay 503");
    if (opts.fail?.has(itemId)) return Promise.resolve(null);
    const aspects = byId[itemId];
    if (!aspects) return Promise.resolve(null);
    return Promise.resolve({ itemId, title: `title ${itemId}`, aspects });
  };
}

// ── tallyAspect ─────────────────────────────────────────────────────────────

Deno.test("a majority value wins with its support", () => {
  const t = tallyAspect(["Lululemon", "Lululemon", "Athleta"]);
  assertEquals(t.value, "Lululemon");
  assertEquals(t.support, 2);
  assertEquals(t.declared, 3);
});

Deno.test("a TIE yields no value, because two products is the likely truth", () => {
  // Two Nike and two Adidas is not a 50/50 brand. It is a signal the visual
  // match pulled in more than one product, which is exactly when asserting
  // either would do the most damage.
  const t = tallyAspect(["Nike", "Adidas", "Nike", "Adidas"]);
  assertEquals(t.value, null);
  assertEquals(t.support, 0);
  assertEquals(t.declared, 4);
  // The disagreement is still reported, so a human can see what was on offer.
  assertEquals(t.candidates.length, 2);
});

Deno.test("capitalisation is not a vote", () => {
  const t = tallyAspect(["lululemon", "Lululemon", "LULULEMON"]);
  assertEquals(t.value, "lululemon");
  assertEquals(t.support, 3);
  assertEquals(t.candidates.length, 1);
});

Deno.test("blank declarations are not declarations", () => {
  const t = tallyAspect(["Patagonia", "   ", ""]);
  assertEquals(t.value, "Patagonia");
  assertEquals(t.declared, 1);
});

// ── gatherVisualAspectEvidence ──────────────────────────────────────────────

Deno.test("brand comes from the structured field, not from the title", async () => {
  // Every title here screams Athleta. Not one listing DECLARES it, so it is
  // not evidence and does not appear.
  const seen: string[] = [];
  const ev = await gatherVisualAspectEvidence({
    comps: [
      comp("1", "Athleta Womens Salutation Legging"),
      comp("2", "Athleta Salutation Stash Pocket Tight"),
      comp("3", "Athleta Legging"),
    ],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({
      "1": { Brand: "Lululemon", Type: "Leggings" },
      "2": { Brand: "Lululemon", Type: "Leggings" },
      "3": { Brand: "Lululemon" },
    }, { seen }),
  });

  assertEquals(ev.aspects.Brand?.value, "Lululemon");
  assertEquals(ev.aspects.Brand?.support, 3);
  assertEquals(ev.aspects.Type?.value, "Leggings");
  assertEquals(ev.listingsRead, 3);
  assertEquals(seen.length, 3);
});

Deno.test("our OWN listings are excluded, so we cannot corroborate ourselves", async () => {
  // Three of these are ours, carrying a brand our own AI wrote. Counting them
  // is how a guess becomes a consensus.
  const seen: string[] = [];
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("mine-1"), comp("mine-2"), comp("mine-3"), comp("theirs")],
    ownItemIds: new Set(["mine-1", "mine-2", "mine-3"]),
    fetchAspects: fakeFetch({
      "mine-1": { Brand: "Wrong Guess" },
      "mine-2": { Brand: "Wrong Guess" },
      "mine-3": { Brand: "Wrong Guess" },
      "theirs": { Brand: "Faherty" },
    }, { seen }),
  });

  assertEquals(ev.ownListingsExcluded, 3);
  assertEquals(ev.listingsRead, 1);
  assertEquals(ev.aspects.Brand?.value, "Faherty");
  // Not merely uncounted - never even fetched.
  assertEquals(seen, ["theirs"]);
});

Deno.test("an aspect nobody declared is ABSENT, not a null consensus", async () => {
  // Absent means "no evidence"; null means "evidence that disagreed". Only the
  // second is a reason for a person to look, so they must not collapse.
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1"), comp("2")],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({
      "1": { Brand: "Nike", Type: "Hoodie" },
      "2": { Brand: "Adidas", Type: "Hoodie" },
    }),
  });

  assertEquals("Material" in ev.aspects, false);
  assertEquals("Brand" in ev.aspects, true);
  assertEquals(ev.aspects.Brand?.value, null); // declared, disagreed
  assertEquals(ev.aspects.Type?.value, "Hoodie");
});

Deno.test("the size of SOMEBODY ELSE'S garment is never harvested", async () => {
  // A visual match is a different physical item that happens to be the same
  // product. Copying its size across would be actively wrong.
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1"), comp("2")],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({
      "1": { Brand: "Nike", Size: "XL", "US Shoe Size": "12" },
      "2": { Brand: "Nike", Size: "XL" },
    }),
  });
  assertEquals(ev.aspects.Brand?.value, "Nike");
  assertEquals("Size" in ev.aspects, false);
});

Deno.test("aspect names are matched case-insensitively", async () => {
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1")],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({ "1": { brand: "Theory", "  TYPE  ": "Popover" } }),
  });
  assertEquals(ev.aspects.Brand?.value, "Theory");
  assertEquals(ev.aspects.Type?.value, "Popover");
});

Deno.test("the read is BOUNDED, however many matches come back", async () => {
  const seen: string[] = [];
  const many = Array.from({ length: 30 }, (_, i) => comp(`c${i}`));
  await gatherVisualAspectEvidence({
    comps: many,
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({}, { seen }),
  });
  assertEquals(seen.length, MAX_ASPECT_READS);
});

Deno.test("a failed read costs one vote, never the identification", async () => {
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1"), comp("2"), comp("3")],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch(
      { "1": { Brand: "Madewell" }, "3": { Brand: "Madewell" } },
      { fail: new Set(["2"]) },
    ),
  });
  assertEquals(ev.readFailures, 1);
  assertEquals(ev.listingsRead, 2);
  assertEquals(ev.aspects.Brand?.value, "Madewell");
});

Deno.test("a THROWN read is caught, not propagated", async () => {
  // The seller is waiting. Thinner evidence beats a 500.
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1"), comp("2")],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch(
      { "2": { Brand: "Ted Baker" } },
      { throwOn: new Set(["1"]) },
    ),
  });
  assertEquals(ev.readFailures, 1);
  assertEquals(ev.aspects.Brand?.value, "Ted Baker");
});

Deno.test("a total outage is empty evidence, not an error", async () => {
  const ev = await gatherVisualAspectEvidence({
    comps: [comp("1"), comp("2")],
    ownItemIds: new Set(),
    fetchAspects: () => {
      throw new Error("eBay is down");
    },
  });
  assertEquals(ev.listingsRead, 0);
  assertEquals(ev.readFailures, 2);
  assertEquals(Object.keys(ev.aspects).length, 0);
});

Deno.test("no comps means no calls", async () => {
  const seen: string[] = [];
  const ev = await gatherVisualAspectEvidence({
    comps: [],
    ownItemIds: new Set(),
    fetchAspects: fakeFetch({}, { seen }),
  });
  assertEquals(seen.length, 0);
  assertEquals(ev.listingsRead, 0);
});
