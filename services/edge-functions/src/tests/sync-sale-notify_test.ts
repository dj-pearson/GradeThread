// US-2699 AC6: what the seller is told when sold-sync ends listings for them.
//
// This notification is the only moment a seller learns that GradeThread pulled
// listings off channels they were not looking at, because of a row the
// extension read off a page. Everything asserted here is about making that
// checkable while the listing can still be re-posted.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildSyncSaleRecorded } from "../lib/marketplace-event-notify.ts";

Deno.test("the siblings are NAMED, not counted", () => {
  // "We also ended 2 listings" does not let a seller check whether we were
  // right. Naming eBay and Mercari does.
  const n = buildSyncSaleRecorded({
    itemTitle: "Carhartt Detroit Jacket",
    platform: "poshmark",
    delistedOn: ["ebay", "mercari"],
    manualOn: [],
  });
  assertStringIncludes(n.message, "eBay");
  assertStringIncludes(n.message, "Mercari");
  assert(!/\b2 listings\b/.test(n.message), "the message counts instead of naming");
});

Deno.test("it says where it sold and what sold", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: "Carhartt Detroit Jacket",
    platform: "poshmark",
    delistedOn: [],
    manualOn: [],
  });
  assertStringIncludes(n.message, "Carhartt Detroit Jacket");
  assertStringIncludes(n.message, "Poshmark");
});

Deno.test("a channel we CANNOT end is stated as the seller's job", () => {
  // Grailed's delete is confirmed by a native browser dialog nothing in a page
  // can answer. A silent omission here is how the same garment sells twice.
  const n = buildSyncSaleRecorded({
    itemTitle: "Raf Simons bomber",
    platform: "poshmark",
    delistedOn: ["ebay"],
    manualOn: ["grailed"],
  });
  assertStringIncludes(n.message, "Grailed");
  assertStringIncludes(n.message, "yourself");
  assertStringIncludes(n.message, "cannot");
});

Deno.test("nothing live elsewhere is said plainly rather than left blank", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: "Levi 501",
    platform: "mercari",
    delistedOn: [],
    manualOn: [],
  });
  assertStringIncludes(n.message, "Nothing was live elsewhere");
});

Deno.test("platform labels are the ones a seller recognises", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: "x",
    platform: "ebay",
    delistedOn: ["poshmark", "vinted", "facebook"],
    manualOn: [],
  });
  assertStringIncludes(n.message, "eBay");
  assertStringIncludes(n.message, "Poshmark");
  assertStringIncludes(n.message, "Vinted");
  assertStringIncludes(n.message, "Facebook");
  // Not the raw keys.
  assert(!n.message.includes("ebay "), "raw platform key leaked into the message");
});

Deno.test("three or more channels read as a sentence, not a comma soup", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: "x",
    platform: "poshmark",
    delistedOn: ["ebay", "mercari", "vinted"],
    manualOn: [],
  });
  assertStringIncludes(n.message, "eBay, Mercari and Vinted");
});

Deno.test("an untitled item still produces a readable sentence", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: null,
    platform: "poshmark",
    delistedOn: ["ebay"],
    manualOn: [],
  });
  assertStringIncludes(n.message, "your listing sold on Poshmark");
});

Deno.test("it reuses sale_recorded rather than inventing a type needing a migration", () => {
  const n = buildSyncSaleRecorded({
    itemTitle: "x",
    platform: "poshmark",
    delistedOn: [],
    manualOn: [],
  });
  assertEquals(n.type, "sale_recorded");
  assertEquals(n.link, "/dashboard/flipdesk/post-sale");
});

Deno.test("the title says the sale came from the browser, not from an API", () => {
  // A seller with eBay connected gets API-sourced sale notices too. If the two
  // read identically they cannot tell which channel to trust when one is wrong.
  const n = buildSyncSaleRecorded({
    itemTitle: "x",
    platform: "poshmark",
    delistedOn: [],
    manualOn: [],
  });
  assertStringIncludes(n.title.toLowerCase(), "synced");
});
