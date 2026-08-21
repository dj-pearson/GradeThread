// US-2756: how Scout identifies an item is one swappable piece.
//
// WHAT THIS IS PROTECTING. eBay visual search is unproven on thrift clothing —
// nobody has run it against real photos yet — so it ships behind a flag that
// defaults to OFF, and the path sellers depend on today must be provably
// untouched while that flag is off. Both halves are asserted here: the default
// provider's behaviour, and the fact that a broken or slow experimental provider
// cannot degrade it.
//
// The flag is read PER REQUEST, not at module load. That is the difference
// between turning the experiment off in a shop and redeploying to turn it off.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  chooseProviders,
  identifyWithFallback,
  type IdentifyOutcome,
  type IdentifyProvider,
  type IdentifyRequest,
} from "../lib/scout-identify.ts";

const REQ: IdentifyRequest = {
  imageDataUri: "data:image/jpeg;base64,AAAA",
  barcode: "",
  q: "carhartt detroit",
  brand: "Carhartt",
  categoryId: "155183",
  size: "",
};

function stub(
  name: IdentifyProvider["name"],
  behaviour: "answer" | "pass" | "throw" | "hang",
  calls?: string[],
): IdentifyProvider {
  return {
    name,
    identify: (_req, _conditionId) => {
      calls?.push(name);
      if (behaviour === "throw") return Promise.reject(new Error(`${name} exploded`));
      if (behaviour === "pass") return Promise.resolve(null);
      if (behaviour === "hang") return new Promise(() => {});
      return Promise.resolve({
        comps: {
          items: [],
          total: 0,
          stats: { count: 0, currency: "USD", min: null, p25: null, median: null, p75: null, max: null },
          // US-2764 made these required on BrowseCompsResult.
          categoryVotes: [],
          leafCategoryVotes: [],
        },
        matchedTitle: `${name} title`,
        // US-2763: provenance travels with every outcome.
        identitySource: null,
        identityIsAuthoritative: false,
        provider: name,
      } as IdentifyOutcome);
    },
  };
}

// ── the flag ───────────────────────────────────────────────────────────────

Deno.test("with the flag unset, only the default provider is used", () => {
  Deno.env.delete("SCOUT_EBAY_IMAGE_SEARCH_ENABLED");
  const names = chooseProviders().map((p) => p.name);
  assertEquals(names, ["hints"]);
});

Deno.test("the flag must be exactly 'true' — anything else stays off", () => {
  // Fail-safe. An operator typing "1" or "yes" or leaving a stale "false" must
  // not silently enable an unproven path in front of sellers.
  for (const value of ["false", "1", "yes", "TRUE", "", " true", "off"]) {
    Deno.env.set("SCOUT_EBAY_IMAGE_SEARCH_ENABLED", value);
    assertEquals(
      chooseProviders().map((p) => p.name),
      ["hints"],
      `the flag value ${JSON.stringify(value)} enabled the experimental provider`,
    );
  }
  Deno.env.delete("SCOUT_EBAY_IMAGE_SEARCH_ENABLED");
});

Deno.test("with the flag on, the image provider is tried FIRST and hints stay as the fallback", () => {
  Deno.env.set("SCOUT_EBAY_IMAGE_SEARCH_ENABLED", "true");
  assertEquals(chooseProviders().map((p) => p.name), ["ebay-image", "hints"]);
  Deno.env.delete("SCOUT_EBAY_IMAGE_SEARCH_ENABLED");
});

Deno.test("the flag is read per call, not captured at module load", () => {
  // The property that decides whether a misbehaving experiment can be switched
  // off from a phone in a shop, or needs a redeploy.
  Deno.env.delete("SCOUT_EBAY_IMAGE_SEARCH_ENABLED");
  assertEquals(chooseProviders().length, 1);
  Deno.env.set("SCOUT_EBAY_IMAGE_SEARCH_ENABLED", "true");
  assertEquals(chooseProviders().length, 2, "turning the flag ON needed a restart");
  Deno.env.delete("SCOUT_EBAY_IMAGE_SEARCH_ENABLED");
  assertEquals(chooseProviders().length, 1, "turning the flag OFF needed a restart");
});

// ── the fallback chain ─────────────────────────────────────────────────────

Deno.test("the first provider that answers wins", async () => {
  const calls: string[] = [];
  const out = await identifyWithFallback(
    [stub("ebay-image", "answer", calls), stub("hints", "answer", calls)],
    REQ,
    "3000",
  );
  assertEquals(out?.provider, "ebay-image");
  assertEquals(calls, ["ebay-image"], "the fallback ran even though the first provider answered");
});

Deno.test("a provider that cannot identify passes to the next, silently", async () => {
  const calls: string[] = [];
  const out = await identifyWithFallback(
    [stub("ebay-image", "pass", calls), stub("hints", "answer", calls)],
    REQ,
    "3000",
  );
  assertEquals(out?.provider, "hints");
  assertEquals(calls, ["ebay-image", "hints"]);
});

Deno.test("a provider that THROWS falls back rather than failing the request", async () => {
  // The seller asked for an appraisal, not for an experiment. An image-search
  // outage must cost them nothing but a few hundred milliseconds.
  const calls: string[] = [];
  const out = await identifyWithFallback(
    [stub("ebay-image", "throw", calls), stub("hints", "answer", calls)],
    REQ,
    "3000",
  );
  assertEquals(out?.provider, "hints");
  assertEquals(calls, ["ebay-image", "hints"]);
});

Deno.test("every provider failing returns null rather than a half-answer", async () => {
  const out = await identifyWithFallback(
    [stub("ebay-image", "throw"), stub("hints", "throw")],
    REQ,
    "3000",
  );
  assertEquals(out, null);
});

Deno.test("the default provider alone still works, which is the flag-off path", async () => {
  const out = await identifyWithFallback([stub("hints", "answer")], REQ, "3000");
  assertEquals(out?.provider, "hints");
});

// ── the experiment cannot make things slow ─────────────────────────────────

Deno.test("a hanging provider is abandoned and the fallback answers", async () => {
  // Without a deadline, an experimental provider that never returns would hang
  // the whole appraisal — strictly worse than not having it. The budget is small
  // because this runs BEFORE the work the seller actually wants.
  const started = Date.now();
  const out = await identifyWithFallback(
    [stub("ebay-image", "hang"), stub("hints", "answer")],
    REQ,
    "3000",
    { timeoutMs: 80 },
  );
  const ms = Date.now() - started;
  assertEquals(out?.provider, "hints");
  assert(ms < 1000, `the hang was not abandoned promptly (${ms}ms)`);
});

Deno.test("the default provider is NOT subject to the experiment's deadline", async () => {
  // Cutting off the path sellers rely on to protect them from the experimental
  // one would be the wrong trade entirely.
  const slowDefault: IdentifyProvider = {
    name: "hints",
    identify: () =>
      new Promise((r) =>
        setTimeout(
          () =>
            r({
              comps: {
          items: [],
          total: 0,
          stats: { count: 0, currency: "USD", min: null, p25: null, median: null, p75: null, max: null },
          // US-2764 made these required on BrowseCompsResult.
          categoryVotes: [],
          leafCategoryVotes: [],
        },
              matchedTitle: null,
              identitySource: null,
              identityIsAuthoritative: false,
              provider: "hints",
            }),
          150,
        )
      ),
  };
  const out = await identifyWithFallback([slowDefault], REQ, "3000", { timeoutMs: 20 });
  assertEquals(out?.provider, "hints", "the default provider was timed out");
});
