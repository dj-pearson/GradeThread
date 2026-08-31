// US-3026: the sold-comps link is built from the SPECIFIC query, not the comp one.
//
// A source scan, because the thing worth pinning is which of three similar
// strings reaches which consumer, and that is a wiring fact rather than a
// behaviour any pure function can be asked about. The regression it guards is
// exactly one substitution: `ebaySoldSearchUrl({ query, categoryId })`, where
// `query` is the brand-led colourless comp string. That line shipped, looked
// correct, and sent a seller holding a cropped top to eBay's completed search
// for every We The Free garment ever listed.
//
// Scoped to the /prospect handler: this file has five handlers, and a file-wide
// search would pass on any one of them being right.

import { assert } from "@std/assert";

async function prospectHandler(): Promise<string> {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskScoutRoutes.post("/prospect"');
  const end = src.indexOf('flipdeskScoutRoutes.post("/buy"');
  if (start === -1 || end <= start) throw new Error("could not isolate /prospect");
  return src.slice(start, end);
}

Deno.test("the sold link is built from the specific query, not the comp query", async () => {
  const handler = await prospectHandler();
  assert(
    /buildSoldSearchQuery\(identity\)/.test(handler),
    "/prospect no longer builds a specific sold-search query",
  );
  // The exact line that shipped the bug. `query` is brand-led and colourless
  // because buildCompKeywords strips colour for the comp maths; handing it to a
  // human-facing link is what produced the brand-only search.
  assert(
    !/ebaySoldSearchUrl\(\{\s*query,\s*categoryId\s*\}\)/.test(handler),
    "the sold link is back on the raw comp query",
  );
});

Deno.test("the comp query is the seed, not the display title", async () => {
  const handler = await prospectHandler();
  assert(
    /buildCompQuerySeed\(identity\)/.test(handler),
    "the comp query no longer comes from the colour-stripped seed",
  );
  // The display title carries the brand's own casing and the colour. Sending it
  // to Browse would search for the colour and halve the sample.
  assert(
    !/q:\s*displayTitle/.test(handler),
    "the display title is being used as the eBay Browse free text",
  );
});

Deno.test("both links, and the words behind them, reach the client", async () => {
  const handler = await prospectHandler();
  for (const field of [
    "ebaySoldSearchUrl:",
    "ebaySoldSearchQuery:",
    "ebayBroadSearchUrl:",
    "ebayBroadSearchQuery:",
  ]) {
    assert(handler.includes(field), `the response no longer carries ${field}`);
  }
});

Deno.test("the broad link is omitted when it would open the same page", async () => {
  // Two rows going to one page is not a choice, it is a bug the seller has to
  // discover by tapping both.
  const handler = await prospectHandler();
  assert(
    /broadSearchQuery\s*&&\s*broadSearchQuery\s*!==\s*soldSearchQuery/.test(handler),
    "the broad link no longer checks that it differs from the specific one",
  );
});

Deno.test("a seller's own title is never overruled by the usability gate", async () => {
  // identityIsUsable exists to stop US from comping the bare word "top" off a
  // photo we could not read. A human who typed it is not that case.
  const handler = await prospectHandler();
  assert(
    /identityIsAuthoritative \|\| identityIsUsable\(identity\)/.test(handler),
    "an authoritative identity is no longer exempt from the usability gate",
  );
});
