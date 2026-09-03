// US-2768: the visual pass in front of the listing path.
//
// Almost every test here is a REFUSAL, and that is the right ratio. This is an
// unproven provider standing in front of the path that writes the listing, so
// what has to be proved is that it can only ever add. The happy path is one
// test; the ways it declines without damage are the rest.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import type { BrowseComp, BrowseCompsResult } from "../lib/ebay-client.ts";
import {
  fetchIdentifyingPhoto,
  runVisualPass,
  startVisualPass,
  VISUAL_SEARCH_LIMIT,
} from "../lib/visual-identify-pass.ts";

const on = () => true;
const off = () => false;

function comp(itemId: string, leaf: string): BrowseComp {
  return {
    itemId,
    title: `listing ${itemId}`,
    price: 45,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: null,
    condition: "Pre-owned",
    buyingOptions: [],
    // US-3098: fixtures state it explicitly; null means 'this source
    // cannot say', which is not the same fact as free shipping.
    shippingCents: null,
    categories: [{ categoryId: leaf, categoryName: "Hoodies & Sweatshirts" }],
    leafCategoryIds: [leaf],
  };
}

function results(items: BrowseComp[]): BrowseCompsResult {
  return {
    items,
    total: items.length,
    stats: {
      count: items.length,
      currency: "USD",
      min: null,
      p25: null,
      median: null,
      p75: null,
      max: null,
    },
    categoryVotes: [],
    leafCategoryVotes: items.length
      ? [{
        categoryId: "155226",
        categoryName: "Hoodies & Sweatshirts",
        count: items.length,
      }]
      : [],
  };
}

/** Aspect gatherer that reports one agreed brand and one agreed type. */
const agreeingAspects = () =>
  Promise.resolve({
    aspects: {
      Brand: {
        value: "Lululemon",
        support: 4,
        declared: 5,
        candidates: [{ value: "Lululemon", count: 4 }],
      },
      Type: {
        value: "Hoodie",
        support: 3,
        declared: 3,
        candidates: [{ value: "Hoodie", count: 3 }],
      },
      // Declared, but split. Must NOT become a candidate.
      Material: {
        value: null,
        support: 0,
        declared: 4,
        candidates: [
          { value: "Cotton", count: 2 },
          { value: "Polyester", count: 2 },
        ],
      },
    },
    listingsRead: 5,
    ownListingsExcluded: 0,
    readFailures: 0,
  });

Deno.test("a front photo with agreeing matches produces candidates", async () => {
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
    gatherAspects: agreeingAspects,
  });

  assertEquals(r.declined, null);
  const byField = Object.fromEntries(r.candidates.map((c) => [c.field, c]));
  assertEquals(byField.brand?.value, "Lululemon");
  assertEquals(byField.brand?.support, 4);
  assertEquals(byField.brand?.outOf, 5);
  assertEquals(byField.type?.value, "Hoodie");
  assertEquals(r.leafCategoryVotes[0]?.categoryId, "155226");
});

Deno.test("a DISAGREED aspect is not offered as a candidate", async () => {
  // Two say Cotton and two say Polyester. Handing the model the top one would
  // be a coin flip dressed as evidence.
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
    gatherAspects: agreeingAspects,
  });
  assert(!r.candidates.some((c) => c.field === "material"));
});

Deno.test("the flag off means NOTHING happens, not a filtered result", async () => {
  let searched = false;
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: off,
    searchByImage: () => {
      searched = true;
      return Promise.resolve(results([comp("1", "155226")]));
    },
  });
  assertEquals(r.declined, "disabled");
  assertEquals(r.candidates, []);
  assertEquals(searched, false);
});

Deno.test("a measurement photo is never sent", async () => {
  // Measured: a tape measure across a hem returned mens dress pants. This is
  // not a degraded call, it is a call whose answer actively misleads.
  let searched = false;
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "measurement",
    enabled: on,
    searchByImage: () => {
      searched = true;
      return Promise.resolve(results([comp("1", "155226")]));
    },
  });
  assertEquals(r.declined, "role_not_identifying");
  assertEquals(searched, false);
});

Deno.test("a defect macro is never sent", async () => {
  // Measured: red fabric with two moth holes returned red fabric by the yard.
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "defect",
    enabled: on,
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
  });
  assertEquals(r.declined, "role_not_identifying");
});

Deno.test("an UNLABELLED photo is declined - unknown is not permission", async () => {
  for (const role of [null, undefined, "", "mystery"]) {
    const r = await runVisualPass({
      imageBase64: "abc",
      imageRole: role,
      enabled: on,
      searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
    });
    assertEquals(r.declined, "role_not_identifying", `role: ${String(role)}`);
  }
});

Deno.test("the roles that MEASURED well are allowed", async () => {
  for (const role of ["front", "back", "flatlay", "label", "tag"]) {
    const r = await runVisualPass({
      imageBase64: "abc",
      imageRole: role,
      enabled: on,
      searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
      gatherAspects: agreeingAspects,
    });
    assertEquals(r.declined, null, `role: ${role}`);
  }
});

Deno.test("no image means no call", async () => {
  const r = await runVisualPass({
    imageBase64: null,
    imageRole: "front",
    enabled: on,
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
  });
  assertEquals(r.declined, "no_image");
});

Deno.test("zero matches is a decline, not an empty consensus", async () => {
  let gathered = false;
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: () => Promise.resolve(results([])),
    gatherAspects: () => {
      gathered = true;
      return agreeingAspects();
    },
  });
  assertEquals(r.declined, "no_matches");
  // No matches means no aspect reads either; that is 5 saved calls.
  assertEquals(gathered, false);
});

Deno.test("a thrown search is caught and costs the extraction nothing", async () => {
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: () => {
      throw new Error("eBay 503");
    },
  });
  assertEquals(r.declined, "error");
  assertEquals(r.candidates, []);
});

Deno.test("a thrown aspect gather is caught too", async () => {
  const r = await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
    gatherAspects: () => {
      throw new Error("boom");
    },
  });
  assertEquals(r.declined, "error");
});

Deno.test("the search asks for more matches than get an aspect read", async () => {
  // The category vote rides free on the search response and sharpens with more
  // listings; each aspect read costs a call. So the two limits differ on
  // purpose and must not be quietly unified.
  let limit: number | undefined;
  await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    searchByImage: (args) => {
      limit = args.limit;
      return Promise.resolve(results([comp("1", "155226")]));
    },
    gatherAspects: agreeingAspects,
  });
  assertEquals(limit, VISUAL_SEARCH_LIMIT);
  assert(VISUAL_SEARCH_LIMIT > 5);
});

Deno.test("our own listing ids are passed through to the aspect read", async () => {
  let seen: ReadonlySet<string> | undefined;
  await runVisualPass({
    imageBase64: "abc",
    imageRole: "front",
    enabled: on,
    ownItemIds: new Set(["mine-1"]),
    searchByImage: () => Promise.resolve(results([comp("1", "155226")])),
    gatherAspects: (args) => {
      seen = args.ownItemIds;
      return agreeingAspects();
    },
  });
  assertEquals(seen?.has("mine-1"), true);
});

// ── Choosing and fetching the photo ─────────────────────────────────────────

Deno.test("no qualifying photo means no fetch at all", async () => {
  // Every one of these is a shot the spike measured as actively misleading.
  const got = await fetchIdentifyingPhoto([
    { url: "http://example.invalid/a.jpg", type: "measurement" },
    { url: "http://example.invalid/b.jpg", type: "defect" },
    { url: "http://example.invalid/c.jpg", type: "detail" },
  ]);
  assertEquals(got, null);
});

Deno.test("an empty photo set is null, not index 0", async () => {
  assertEquals(await fetchIdentifyingPhoto([]), null);
});

Deno.test("an unreachable photo is null rather than a throw", async () => {
  const got = await fetchIdentifyingPhoto(
    [{ url: "http://127.0.0.1:1/nope.jpg", type: "front" }],
    { timeoutMs: 200 },
  );
  assertEquals(got, null);
});

Deno.test("startVisualPass with the flag off fetches NOTHING", async () => {
  // A disabled experiment must cost nothing at all - not even one wasted image
  // download per extraction.
  const r = await startVisualPass(
    [{ url: "http://127.0.0.1:1/would-hang.jpg", type: "front" }],
    { enabled: off },
  );
  assertEquals(r.declined, "disabled");
});

Deno.test("startVisualPass declines an unlabelled photo set without searching", async () => {
  const r = await startVisualPass(
    [{ url: "http://127.0.0.1:1/x.jpg", type: "detail" }],
    { enabled: on },
  );
  assertEquals(r.declined, "role_not_identifying");
  assertEquals(r.candidates, []);
});

Deno.test("startVisualPass NEVER rejects, so the caller can hold the promise", async () => {
  // The route starts this and hands the promise onward without a catch. A
  // rejection nobody is attached to yet is an unhandled rejection, and in this
  // service that is a crash-loop.
  const r = await startVisualPass(
    [{ url: "http://127.0.0.1:1/dead.jpg", type: "front" }],
    { enabled: on },
  );
  assert(r.declined !== null);
  assertEquals(r.candidates, []);
});
