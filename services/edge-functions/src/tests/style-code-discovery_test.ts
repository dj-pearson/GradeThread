// US-2782: the brand-first style-code crawl, tested without eBay, without the
// database and without a clock.
//
// The case that matters most is the one asserting a title cannot create a code.
// The whole module exists because the market's titles look like evidence and
// are not (US-2751), and the cheapest way to lose that is a well-meaning edit
// that "also checks the title when the aspects are empty".

import { assertEquals } from "@std/assert";
import {
  type BrandOutcome,
  BRAND_COOLDOWN_DAYS,
  crawlBrand,
  type DiscoveryDeps,
  type DiscoveryFind,
  type DiscoveryListing,
  type DiscoveryStateRow,
  EXHAUSTED_COOLDOWN_DAYS,
  EXHAUSTED_EMPTY_PASSES,
  harvestListing,
  MAX_DISCOVERY_OFFSET,
  MAX_TITLES_PER_CODE,
  nextCursor,
  pickDiscoveryTargets,
  planDiscoveryWrites,
  summarizeDiscovery,
} from "../lib/style-code-discovery.ts";

const NOW = new Date("2026-08-21T03:10:00Z");
const MS_PER_DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

function brand(key: string, label = key) {
  return { brandKey: key, brandLabel: label };
}

function state(
  key: string,
  over: Partial<DiscoveryStateRow> = {},
): DiscoveryStateRow {
  return {
    brand_key: key,
    page_offset: 0,
    last_run_at: null,
    empty_passes: 0,
    ...over,
  };
}

/** Uppercase, punctuation stripped — the shape canonicalStyleCode has for a
 *  brand with no decoder. Enough for every rule under test here. */
const canon = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

function listing(
  itemId: string,
  aspects: Record<string, string>,
  title = "Some Brand Garment Size M",
): DiscoveryListing {
  return { itemId, title, aspects, url: `https://ebay.com/itm/${itemId}` };
}

// ── pickDiscoveryTargets ────────────────────────────────────────────────────

Deno.test("a brand nobody has crawled goes ahead of every brand that has", () => {
  const work = pickDiscoveryTargets({
    brands: [brand("carhartt"), brand("patagonia"), brand("lululemon")],
    state: [
      state("carhartt", { last_run_at: daysAgo(40) }),
      state("patagonia", { last_run_at: daysAgo(90) }),
      // lululemon: no row at all
    ],
    budget: 3,
    now: NOW,
  });

  assertEquals(work.targets.map((t) => t.brandKey), [
    "lululemon",
    "patagonia",
    "carhartt",
  ]);
  assertEquals(work.deferred, 0);
});

Deno.test("a brand inside its cooldown is skipped, not crawled", () => {
  const work = pickDiscoveryTargets({
    brands: [brand("carhartt"), brand("patagonia")],
    state: [
      state("carhartt", { last_run_at: daysAgo(BRAND_COOLDOWN_DAYS - 1) }),
      state("patagonia", { last_run_at: daysAgo(BRAND_COOLDOWN_DAYS + 1) }),
    ],
    budget: 5,
    now: NOW,
  });

  assertEquals(work.targets.map((t) => t.brandKey), ["patagonia"]);
  assertEquals(work.skippedCooldown, 1);
  assertEquals(work.skippedExhausted, 0);
});

Deno.test("an exhausted brand takes the LONG cooldown, not the short one", () => {
  const between = (BRAND_COOLDOWN_DAYS + EXHAUSTED_COOLDOWN_DAYS) / 2;
  const work = pickDiscoveryTargets({
    brands: [brand("carhartt")],
    state: [
      state("carhartt", {
        last_run_at: daysAgo(between),
        empty_passes: EXHAUSTED_EMPTY_PASSES,
      }),
    ],
    budget: 5,
    now: NOW,
  });

  // Past the short cooldown and inside the long one: skipped, and counted as
  // exhausted rather than as an ordinary cooldown so the two are tellable apart.
  assertEquals(work.targets.length, 0);
  assertEquals(work.skippedExhausted, 1);
  assertEquals(work.skippedCooldown, 0);
});

Deno.test("a cursor past eBay's ceiling wraps to zero and is marked wrapped", () => {
  const work = pickDiscoveryTargets({
    brands: [brand("carhartt")],
    state: [
      state("carhartt", {
        page_offset: MAX_DISCOVERY_OFFSET,
        last_run_at: daysAgo(EXHAUSTED_COOLDOWN_DAYS + 1),
      }),
    ],
    budget: 5,
    now: NOW,
  });

  assertEquals(work.targets.length, 1);
  assertEquals(work.targets[0]!.offset, 0);
  assertEquals(work.targets[0]!.wrapped, true);
});

Deno.test("eligible brands past the budget are reported as deferred, not dropped", () => {
  const work = pickDiscoveryTargets({
    brands: [brand("a"), brand("b"), brand("c"), brand("d")],
    state: [],
    budget: 2,
    now: NOW,
  });

  assertEquals(work.targets.length, 2);
  assertEquals(work.deferred, 2);
  assertEquals(work.considered, 4);
});

Deno.test("a brand listed twice under one key is crawled once", () => {
  const work = pickDiscoveryTargets({
    brands: [brand("carhartt", "Carhartt"), brand("carhartt", "CARHARTT")],
    state: [],
    budget: 5,
    now: NOW,
  });

  assertEquals(work.targets.length, 1);
});

// ── harvestListing ──────────────────────────────────────────────────────────

Deno.test("a declared style code in a structured field is a find", () => {
  const find = harvestListing({
    listing: listing("v1", {
      "Style Code": "lw7d-vcs",
      "Model": "Align High-Rise Pant",
    }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(find?.codeNorm, "LW7DVCS");
  assertEquals(find?.codeRaw, "lw7d-vcs");
  assertEquals(find?.name, "Align High-Rise Pant");
});

Deno.test("a style code that appears ONLY in the title is not a find", () => {
  // The whole point of the module. A title is marketing text; a consensus over
  // guesses is a confident guess (US-2751).
  const find = harvestListing({
    listing: listing("v1", { "Department": "Women" }, "Lululemon LW7DVCS Align Pant 6"),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(find, null);
});

Deno.test("a one-word Model value is a silhouette, not a product name", () => {
  const find = harvestListing({
    listing: listing("v1", { MPN: "ABC123", Model: "Jogger" }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  // The code is still worth keeping; the name is not.
  assertEquals(find?.codeNorm, "ABC123");
  assertEquals(find?.name, null);
});

Deno.test("a code too short to be an identity is refused", () => {
  const find = harvestListing({
    listing: listing("v1", { MPN: "A1" }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(find, null);
});

Deno.test("our own listing is never harvested", () => {
  const find = harvestListing({
    listing: listing("mine", { "Style Code": "ABC123", Model: "Better Sweater Jacket" }),
    canonicalize: canon,
    ownItemIds: new Set(["mine"]),
  });

  assertEquals(find, null);
});

// ── planDiscoveryWrites ─────────────────────────────────────────────────────

function find(over: Partial<DiscoveryFind>): DiscoveryFind {
  return {
    itemId: "v1",
    codeNorm: "ABC123",
    codeRaw: "ABC-123",
    name: null,
    title: "A Perfectly Ordinary Listing Title",
    url: null,
    ...over,
  };
}

Deno.test("ten listings of one garment collapse to one write", () => {
  const finds = Array.from({ length: 10 }, (_, i) =>
    find({ itemId: `v${i}`, title: `Listing number ${i} of the same thing` }));

  const writes = planDiscoveryWrites(finds);

  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.titles.length, MAX_TITLES_PER_CODE);
});

Deno.test("confirmed names that AGREE produce a name and a supporting count", () => {
  const writes = planDiscoveryWrites([
    find({ itemId: "v1", name: "Better Sweater Jacket" }),
    find({ itemId: "v2", name: "better  sweater jacket", title: "Second title here" }),
  ]);

  assertEquals(writes[0]!.name, "Better Sweater Jacket");
  assertEquals(writes[0]!.supporting, 2);
});

Deno.test("confirmed names that DISAGREE produce no name at all", () => {
  // Two people who both read the tag and disagree is a question for a human,
  // not something to settle by counting.
  const writes = planDiscoveryWrites([
    find({ itemId: "v1", name: "Better Sweater Jacket" }),
    find({ itemId: "v2", name: "Nano Puff Hoody", title: "Second title here" }),
  ]);

  assertEquals(writes[0]!.name, null);
  assertEquals(writes[0]!.supporting, 0);
});

Deno.test("two different codes on a page are two writes", () => {
  const writes = planDiscoveryWrites([
    find({ itemId: "v1", codeNorm: "ABC123" }),
    find({ itemId: "v2", codeNorm: "XYZ789", title: "Another title entirely" }),
  ]);

  assertEquals(writes.length, 2);
});

// ── nextCursor ──────────────────────────────────────────────────────────────

Deno.test("a full page advances the cursor by what came back", () => {
  assertEquals(nextCursor({ offset: 100, requested: 50, returned: 50 }), 150);
});

Deno.test("a short page means eBay is out of listings, so the cursor jumps to the ceiling", () => {
  assertEquals(
    nextCursor({ offset: 100, requested: 50, returned: 12 }),
    MAX_DISCOVERY_OFFSET,
  );
});

Deno.test("the cursor never advances past the ceiling", () => {
  assertEquals(
    nextCursor({ offset: MAX_DISCOVERY_OFFSET - 10, requested: 50, returned: 50 }),
    MAX_DISCOVERY_OFFSET,
  );
});

// ── crawlBrand ──────────────────────────────────────────────────────────────

function stubDeps(over: Partial<DiscoveryDeps> = {}): {
  deps: DiscoveryDeps;
  calls: { aspects: string[]; codes: string[]; names: string[]; marked: unknown[] };
} {
  const calls = {
    aspects: [] as string[],
    codes: [] as string[],
    names: [] as string[],
    marked: [] as unknown[],
  };
  const deps: DiscoveryDeps = {
    page: () => Promise.resolve([]),
    aspects: (itemId) => {
      calls.aspects.push(itemId);
      return Promise.resolve(null);
    },
    canonicalize: (_brandKey, raw) => canon(raw),
    knownCodes: () => Promise.resolve(new Set<string>()),
    writeCode: (_b, w) => {
      calls.codes.push(w.codeNorm);
      return Promise.resolve();
    },
    writeName: (_b, w) => {
      calls.names.push(w.name ?? "");
      return Promise.resolve();
    },
    markCrawled: (args) => {
      calls.marked.push(args);
      return Promise.resolve();
    },
    ...over,
  };
  return { deps, calls };
}

const TARGET = {
  brandKey: "patagonia",
  brandLabel: "Patagonia",
  offset: 0,
  wrapped: false,
};

Deno.test("our own listings cost no eBay lookup at all", async () => {
  const { deps, calls } = stubDeps({
    page: () =>
      Promise.resolve([
        { itemId: "mine", title: "Ours", url: null },
        { itemId: "theirs", title: "Theirs", url: null },
      ]),
  });

  const outcome = await crawlBrand({
    target: TARGET,
    deps,
    ownItemIds: new Set(["mine"]),
    lookups: 10,
  });

  // Filtered BEFORE the lookup, not after: paying eBay to read back specifics
  // our own AI wrote is the expensive way to learn nothing.
  assertEquals(calls.aspects, ["theirs"]);
  assertEquals(outcome.ownSkipped, 1);
  assertEquals(outcome.inspected, 1);
});

Deno.test("the lookup budget bounds how many listings are inspected", async () => {
  const { deps, calls } = stubDeps({
    page: () =>
      Promise.resolve(
        Array.from({ length: 20 }, (_, i) => ({
          itemId: `v${i}`,
          title: `Listing ${i}`,
          url: null,
        })),
      ),
  });

  const outcome = await crawlBrand({
    target: TARGET,
    deps,
    ownItemIds: new Set(),
    lookups: 4,
  });

  assertEquals(calls.aspects.length, 4);
  assertEquals(outcome.scanned, 20);
  assertEquals(outcome.inspected, 4);
});

Deno.test("a code already in the index is written but not counted as new", async () => {
  const { deps } = stubDeps({
    page: () => Promise.resolve([{ itemId: "v1", title: "A listing", url: null }]),
    aspects: () =>
      Promise.resolve(
        listing("v1", { "Style Code": "ABC123", Model: "Nano Puff Hoody" }),
      ),
    knownCodes: () => Promise.resolve(new Set(["ABC123"])),
  });

  const outcome = await crawlBrand({
    target: TARGET,
    deps,
    ownItemIds: new Set(),
    lookups: 10,
  });

  assertEquals(outcome.codes, 1);
  assertEquals(outcome.newCodes, 0);
  assertEquals(outcome.names, 1);
});

Deno.test("a failed page records the attempt at the SAME offset", async () => {
  const { deps, calls } = stubDeps({
    page: () => Promise.reject(new Error("eBay said no")),
  });

  const outcome = await crawlBrand({
    target: { ...TARGET, offset: 300 },
    deps,
    ownItemIds: new Set(),
    lookups: 10,
  });

  assertEquals(outcome.failed, true);
  // The cursor must not advance past listings nobody looked at, and the attempt
  // must still be recorded or a permanently failing brand is retried nightly.
  assertEquals(outcome.nextOffset, 300);
  assertEquals(calls.marked.length, 1);
});

Deno.test("a cursor write that fails does not throw away the codes just learned", async () => {
  const { deps, calls } = stubDeps({
    page: () => Promise.resolve([{ itemId: "v1", title: "A listing", url: null }]),
    aspects: () => Promise.resolve(listing("v1", { MPN: "ABC123" })),
    markCrawled: () => Promise.reject(new Error("cursor write failed")),
  });

  const outcome = await crawlBrand({
    target: TARGET,
    deps,
    ownItemIds: new Set(),
    lookups: 10,
  });

  assertEquals(calls.codes, ["ABC123"]);
  assertEquals(outcome.failed, false);
});

// ── summarizeDiscovery ──────────────────────────────────────────────────────

Deno.test("the summary adds up every brand's pass", () => {
  const outcomes: BrandOutcome[] = [
    {
      brandKey: "a",
      scanned: 50,
      inspected: 20,
      declared: 6,
      codes: 4,
      newCodes: 3,
      names: 2,
      ownSkipped: 1,
      nextOffset: 50,
      failed: false,
    },
    {
      brandKey: "b",
      scanned: 10,
      inspected: 10,
      declared: 1,
      codes: 1,
      newCodes: 0,
      names: 0,
      ownSkipped: 0,
      nextOffset: MAX_DISCOVERY_OFFSET,
      failed: true,
    },
  ];

  assertEquals(summarizeDiscovery(outcomes), {
    crawled: 2,
    scanned: 60,
    inspected: 30,
    declared: 7,
    codes: 5,
    newCodes: 3,
    names: 2,
    ownSkipped: 1,
    failed: 1,
  });
});

// ── the cron itself ─────────────────────────────────────────────────────────

Deno.test("US-2784: a tick that cannot take the lock crawls nothing", async () => {
  Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
  Deno.env.set(
    "SUPABASE_SERVICE_ROLE_KEY",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
  );
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "test-job-secret");
  const { handleStyleCodeDiscoveryCron } = await import(
    "../routes/jobs-style-code-discovery.ts"
  );

  let paged = 0;
  const { deps } = stubDeps({
    page: () => {
      paged++;
      return Promise.resolve([]);
    },
  });

  let released = 0;
  const heldLock = () =>
    Promise.resolve({
      acquired: false as const,
      reason: "held by another worker",
      release: () => {
        released++;
        return Promise.resolve();
      },
    });

  const body: Record<string, unknown>[] = [];
  const ctx = {
    req: {
      header: (name: string) =>
        name === "X-Internal-Job-Secret" ? "test-job-secret" : undefined,
    },
    json: (payload: Record<string, unknown>) => {
      body.push(payload);
      return new Response(JSON.stringify(payload));
    },
  };

  await handleStyleCodeDiscoveryCron(ctx as never, deps, heldLock as never);

  assertEquals(body[0]?.skipped, true);
  // Not a smaller crawl, not a retry. Zero eBay calls.
  assertEquals(paged, 0);
  // And a lock it never took is not released out from under the running tick.
  assertEquals(released, 0);
});

Deno.test("US-2784: the route reads no tenant table but the own-listing exclusion", async () => {
  // The crawl is job-secret gated rather than user-scoped, so it has no case in
  // tenant-isolation_test.ts (which drives two real user sessions). The
  // equivalent guarantee is that it never NAMES a tenant table — except
  // `listings`, which it reads to throw our own inventory away.
  const src = await Deno.readTextFile(
    new URL("../routes/jobs-style-code-discovery.ts", import.meta.url),
  );
  const tables = [...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assertEquals(tables, ["listings", "style_code_observations"]);

  // And that `listings` read selects the platform id and nothing else — no
  // owner, no title, no price.
  assertEquals(src.includes('.select("platform_listing_id")'), true);
});
