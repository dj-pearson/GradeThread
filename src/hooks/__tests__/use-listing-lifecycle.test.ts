// US-2162 / US-2163 / US-2166: lock in the platform-agnostic listing lifecycle.
//
// These assert the exact properties whose absence caused the bug:
//   1. price/end hit /api/flipdesk/listings/*, NOT /api/flipdesk/ebay/listings/*.
//      The eBay routes 409 on any non-eBay row, and the 409 is what the old code
//      swallowed into a local-only write.
//   2. a failure THROWS, carrying status + code. Nothing in these hooks may
//      "succeed locally" — that state is what let a seller's local price and
//      listing status diverge from a live marketplace listing.
//   3. bulk operations send ONE request containing every id, not one per id.
//      The old loop also tripped the 30-req/60s rate limit on this router at
//      around the 30th selected row, so large bulk actions half-finished.
//
// edgeFetch is mocked at the module boundary, so these run headless and assert
// the request contract rather than React state.
import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));

// The hooks call useQueryClient() only to invalidate on success; stub it so the
// mutationFn can be exercised without mounting a provider.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // Return the options object so a test can invoke mutationFn directly.
  useMutation: (opts: unknown) => opts,
}));

const {
  BULK_PRICE_CHUNK_SIZE,
  chunkForBulkPrice,
  mergeBulkPriceResponses,
  undoableFrom,
  useBulkEndListings,
  useBulkListingPrice,
  useEndListing,
  useUpdateListingPrice,
} = await import("@/hooks/use-listing-lifecycle");

type MutationLike<TArgs, TResult> = {
  mutationFn: (args: TArgs) => Promise<TResult>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** The path passed to edgeFetch on the most recent call. */
function lastPath(): string {
  const calls = edgeFetch.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

/** The JSON body passed to edgeFetch on the most recent call. */
function lastJson(): Record<string, unknown> {
  const calls = edgeFetch.mock.calls;
  const opts = calls[calls.length - 1]?.[1] as { json?: Record<string, unknown> };
  return opts?.json ?? {};
}

beforeEach(() => {
  edgeFetch.mockReset();
});

describe("useUpdateListingPrice", () => {
  it("calls the platform-agnostic route, never the eBay one", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, listing_id: "l1", price: 12.5, pushed: true }),
    );
    const hook = useUpdateListingPrice() as unknown as MutationLike<
      { listingId: string; price: number },
      { pushed: boolean }
    >;
    const res = await hook.mutationFn({ listingId: "l1", price: 12.5 });

    expect(lastPath()).toBe("/api/flipdesk/listings/l1/price");
    // The regression guard: this must never route through the eBay namespace.
    expect(lastPath()).not.toContain("/ebay/");
    expect(lastJson()).toEqual({ price: 12.5 });
    expect(res.pushed).toBe(true);
  });

  it("url-encodes the listing id", async () => {
    edgeFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const hook = useUpdateListingPrice() as unknown as MutationLike<
      { listingId: string; price: number },
      unknown
    >;
    await hook.mutationFn({ listingId: "a/b", price: 1 });
    expect(lastPath()).toBe("/api/flipdesk/listings/a%2Fb/price");
  });

  it("throws on failure instead of falling back to a local write", async () => {
    // This is the whole point. The old code caught a 409 here and wrote the
    // price straight to the listings table, leaving a number the marketplace
    // never saw.
    edgeFetch.mockResolvedValue(
      jsonResponse({ error: "Shopify is not connected.", code: "not_connected" }, 409),
    );
    const hook = useUpdateListingPrice() as unknown as MutationLike<
      { listingId: string; price: number },
      unknown
    >;
    await expect(hook.mutationFn({ listingId: "l1", price: 5 })).rejects.toThrow(
      "Shopify is not connected.",
    );
  });

  it("carries the status and code onto the thrown error", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ error: "nope", code: "not_connected" }, 409),
    );
    const hook = useUpdateListingPrice() as unknown as MutationLike<
      { listingId: string; price: number },
      unknown
    >;
    const err = await hook
      .mutationFn({ listingId: "l1", price: 5 })
      .catch((e: Error & { status?: number; code?: string }) => e);
    expect((err as Error & { status?: number }).status).toBe(409);
    expect((err as Error & { code?: string }).code).toBe("not_connected");
  });
});

describe("useEndListing", () => {
  it("posts to the agnostic end route", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, listing_id: "l1", ended_upstream: true }),
    );
    const hook = useEndListing() as unknown as MutationLike<
      { listingId: string },
      { ended_upstream?: boolean }
    >;
    const res = await hook.mutationFn({ listingId: "l1" });

    expect(lastPath()).toBe("/api/flipdesk/listings/l1/end");
    expect(lastPath()).not.toContain("/ebay/");
    expect(res.ended_upstream).toBe(true);
  });

  it("throws when the marketplace refused, so the UI can't claim it ended", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse(
        { error: "Etsy couldn't end this listing — it's still live.", code: "delist_failed" },
        502,
      ),
    );
    const hook = useEndListing() as unknown as MutationLike<{ listingId: string }, unknown>;
    await expect(hook.mutationFn({ listingId: "l1" })).rejects.toThrow("still live");
  });

  // US-2162 (AC3): Poshmark/Mercari/Grailed have no server-side delist API, so
  // the server queues the row for the Lister extension instead of refusing. The
  // response must carry `queued` WITH `ended_upstream: false` — the listing is
  // still live and buyable until the extension runs, and the UI keys the
  // still-live warning off exactly this shape.
  it("surfaces a queued extension delist as NOT ended upstream", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        listing_id: "l1",
        ended_upstream: false,
        queued: true,
        note: "Poshmark has no end-listing API, so the GradeThread Lister " +
          "extension will end it in your browser next time you open FlipDesk. " +
          "It stays live until then.",
      }),
    );
    const hook = useEndListing() as unknown as MutationLike<
      { listingId: string },
      { ended_upstream?: boolean; queued?: boolean; note?: string }
    >;
    const res = await hook.mutationFn({ listingId: "l1" });

    expect(res.queued).toBe(true);
    // The pairing is the contract: queued must never arrive claiming the
    // marketplace listing is gone.
    expect(res.ended_upstream).toBe(false);
    expect(res.note).toContain("stays live");
  });

  // US-2162 (AC6): the regression guard. A non-eBay listing must never be ended
  // through the eBay namespace, regardless of whether an eBay connection exists
  // — the old code gated on `ebayConnection` rather than the row's platform, so
  // a Shopify row was sent to the eBay endpoint, 409'd, and fell through to a
  // local-only write that reported success.
  it("never routes a non-eBay listing id through the eBay namespace", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, listing_id: "shopify-row", ended_upstream: true }),
    );
    const hook = useEndListing() as unknown as MutationLike<
      { listingId: string },
      unknown
    >;
    await hook.mutationFn({ listingId: "shopify-row" });

    expect(lastPath()).toBe("/api/flipdesk/listings/shopify-row/end");
    expect(lastPath()).not.toContain("/ebay/");
    // One call: no eBay attempt, no fallback second request.
    expect(edgeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("useBulkListingPrice", () => {
  it("sends every id in ONE request", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, total: 3, succeeded: 3, failed: 0, results: [] }),
    );
    const hook = useBulkListingPrice() as unknown as MutationLike<
      { listingIds: string[]; dropPct?: number },
      unknown
    >;
    await hook.mutationFn({ listingIds: ["a", "b", "c"], dropPct: 10 });

    // One call, not one per listing — the old loop made N.
    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(lastPath()).toBe("/api/flipdesk/listings/bulk-price");
    expect(lastJson()).toEqual({ listing_ids: ["a", "b", "c"], drop_pct: 10 });
  });

  it("sends an explicit price when given one, and no drop_pct", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, total: 1, succeeded: 1, failed: 0, results: [] }),
    );
    const hook = useBulkListingPrice() as unknown as MutationLike<
      { listingIds: string[]; price?: number },
      unknown
    >;
    await hook.mutationFn({ listingIds: ["a"], price: 20 });
    expect(lastJson()).toEqual({ listing_ids: ["a"], price: 20 });
    expect(lastJson()).not.toHaveProperty("drop_pct");
  });

  it("surfaces per-row failures rather than a bare count", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { listing_id: "a", ok: true, price: 9, pushed: true },
          { listing_id: "b", ok: false, error: "Shopify rejected the price update." },
        ],
      }),
    );
    const hook = useBulkListingPrice() as unknown as MutationLike<
      { listingIds: string[]; dropPct?: number },
      { failed: number; results: Array<{ ok: boolean; error?: string }> }
    >;
    const res = await hook.mutationFn({ listingIds: ["a", "b"], dropPct: 10 });

    expect(res.failed).toBe(1);
    // A failed row must carry a reason the seller can act on.
    expect(res.results.find((r) => !r.ok)?.error).toContain("Shopify");
  });

  // US-2163 (AC6): a mixed eBay + Shopify selection must reprice BOTH upstream
  // and report each row's outcome. The old code sent every row to the eBay
  // endpoint; the Shopify row 409'd and its local price was advanced anyway and
  // reported as "updated locally only" — a number that marketplace never saw,
  // which then fed margin and ROI.
  it("reprices a mixed eBay + Shopify selection upstream, per row", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        total: 2,
        succeeded: 2,
        failed: 0,
        results: [
          {
            listing_id: "ebay-row",
            ok: true,
            price: 45,
            previous_price: 50,
            pushed: true,
          },
          {
            listing_id: "shopify-row",
            ok: true,
            price: 27,
            previous_price: 30,
            pushed: true,
          },
        ],
      }),
    );
    const hook = useBulkListingPrice() as unknown as MutationLike<
      { listingIds: string[]; dropPct?: number },
      {
        succeeded: number;
        results: Array<{ listing_id: string; ok: boolean; pushed?: boolean }>;
      }
    >;
    const res = await hook.mutationFn({
      listingIds: ["ebay-row", "shopify-row"],
      dropPct: 10,
    });

    // One agnostic request carried both platforms — never the eBay namespace.
    expect(lastPath()).toBe("/api/flipdesk/listings/bulk-price");
    expect(lastPath()).not.toContain("/ebay/");
    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(lastJson()).toEqual({
      listing_ids: ["ebay-row", "shopify-row"],
      drop_pct: 10,
    });

    // `pushed` on BOTH is the claim that matters: each row reached its own
    // marketplace, rather than one succeeding and the other being written local
    // only. A row reported ok:true with pushed:false would be the old bug.
    expect(res.succeeded).toBe(2);
    expect(res.results.every((r) => r.ok && r.pushed)).toBe(true);
    expect(res.results.map((r) => r.listing_id)).toEqual([
      "ebay-row",
      "shopify-row",
    ]);
  });
});

describe("useBulkEndListings", () => {
  it("sends every id in ONE request", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, total: 2, succeeded: 2, failed: 0, results: [] }),
    );
    const hook = useBulkEndListings() as unknown as MutationLike<
      { listingIds: string[] },
      unknown
    >;
    await hook.mutationFn({ listingIds: ["a", "b"] });

    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(lastPath()).toBe("/api/flipdesk/listings/bulk-end");
    expect(lastJson()).toEqual({ listing_ids: ["a", "b"] });
  });

  it("reports rows that are still live as failures", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { listing_id: "a", ok: true, ended_upstream: true },
          { listing_id: "b", ok: false, error: "Etsy couldn't end this listing — it's still live." },
        ],
      }),
    );
    const hook = useBulkEndListings() as unknown as MutationLike<
      { listingIds: string[] },
      { failed: number; results: Array<{ ok: boolean; error?: string }> }
    >;
    const res = await hook.mutationFn({ listingIds: ["a", "b"] });

    expect(res.failed).toBe(1);
    expect(res.results.find((r) => !r.ok)?.error).toContain("still live");
  });
});

describe("undoableFrom (US-2172)", () => {
  type Row = {
    listing_id: string;
    ok: boolean;
    price?: number;
    previous_price?: number | null;
    pushed?: boolean;
    error?: string;
  };
  const res = (results: Row[]) => ({
    ok: true as const,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });

  it("returns each row's own former price", () => {
    // The whole reason undo needs the per-row shape: these two go back to
    // DIFFERENT numbers. A single shared price could not express this.
    expect(
      undoableFrom(
        res([
          { listing_id: "a", ok: true, price: 9, previous_price: 10 },
          { listing_id: "b", ok: true, price: 45, previous_price: 50 },
        ]),
      ),
    ).toEqual([
      { listingId: "a", price: 10 },
      { listingId: "b", price: 50 },
    ]);
  });

  it("excludes rows the marketplace refused", () => {
    // A failed row never changed. Pushing its previous_price would send a price
    // nobody asked for, to a listing that is already correct.
    expect(
      undoableFrom(
        res([
          { listing_id: "a", ok: true, price: 9, previous_price: 10 },
          { listing_id: "b", ok: false, previous_price: 50, error: "Shopify refused." },
        ]),
      ),
    ).toEqual([{ listingId: "a", price: 10 }]);
  });

  it("excludes rows with no known previous price", () => {
    // Nothing to restore to. Guessing would be worse than not offering undo.
    expect(
      undoableFrom(
        res([
          { listing_id: "a", ok: true, price: 9, previous_price: null },
          { listing_id: "b", ok: true, price: 9 },
        ]),
      ),
    ).toEqual([]);
  });

  it("excludes no-op rows", () => {
    // Price unchanged — a round trip that would achieve nothing.
    expect(
      undoableFrom(
        res([{ listing_id: "a", ok: true, price: 10, previous_price: 10 }]),
      ),
    ).toEqual([]);
  });

  it("excludes a non-positive previous price", () => {
    // listing_price is NOT NULL and non-negative in the schema, but a 0 would
    // be rejected by the endpoint's own validation — filter it here rather than
    // sending a request guaranteed to 400.
    expect(
      undoableFrom(
        res([{ listing_id: "a", ok: true, price: 9, previous_price: 0 }]),
      ),
    ).toEqual([]);
  });

  it("returns nothing when the whole batch failed, so no undo is offered", () => {
    expect(
      undoableFrom(
        res([
          { listing_id: "a", ok: false, error: "boom" },
          { listing_id: "b", ok: false, error: "boom" },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("useBulkListingPrice per-row shape (US-2172)", () => {
  it("sends items and omits listing_ids", async () => {
    edgeFetch.mockResolvedValue(
      jsonResponse({ ok: true, total: 2, succeeded: 2, failed: 0, results: [] }),
    );
    const hook = useBulkListingPrice() as unknown as MutationLike<
      { items: Array<{ listingId: string; price: number }> },
      unknown
    >;
    await hook.mutationFn({
      items: [
        { listingId: "a", price: 10 },
        { listingId: "b", price: 50 },
      ],
    });

    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(lastJson()).toEqual({
      items: [
        { listing_id: "a", price: 10 },
        { listing_id: "b", price: 50 },
      ],
    });
    // Sending both would let the two disagree; the server derives ids from items.
    expect(lastJson()).not.toHaveProperty("listing_ids");
  });
});

// ── US-2163 (AC2 + AC5): chunking is what makes progress and cancel possible ──

describe("chunkForBulkPrice", () => {
  it("splits at 25, matching /listings/bulk-price-quantity", () => {
    expect(BULK_PRICE_CHUNK_SIZE).toBe(25);
    const ids = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const chunks = chunkForBulkPrice(ids);
    expect(chunks.map((c) => c.length)).toEqual([25, 25, 10]);
    // Nothing is lost or duplicated in the split.
    expect(chunks.flat()).toEqual(ids);
  });

  it("keeps a small selection to a single request", () => {
    // The whole point is NOT to go back to one call per listing.
    expect(chunkForBulkPrice(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
    expect(chunkForBulkPrice([])).toEqual([]);
  });

  it("costs 4 requests for the 100-listing cap, not 100", () => {
    // The old browser loop tripped the 30-req/60s limit around row 30.
    const ids = Array.from({ length: 100 }, (_, i) => `l${i}`);
    expect(chunkForBulkPrice(ids)).toHaveLength(4);
  });
});

describe("mergeBulkPriceResponses", () => {
  const part = (rows: Array<{ listing_id: string; ok: boolean }>) => ({
    ok: true as const,
    total: rows.length,
    succeeded: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    results: rows,
  });

  it("recomputes counts from the merged rows", () => {
    const merged = mergeBulkPriceResponses([
      part([{ listing_id: "a", ok: true }, { listing_id: "b", ok: false }]),
      part([{ listing_id: "c", ok: true }]),
    ]);
    expect(merged.total).toBe(3);
    expect(merged.succeeded).toBe(2);
    expect(merged.failed).toBe(1);
    expect(merged.results.map((r) => r.listing_id)).toEqual(["a", "b", "c"]);
  });

  it("a cancelled batch reports only what was actually sent", () => {
    // This is the honesty property: counts come from the rows we have, never
    // from the size of the selection. A seller who stopped after one chunk must
    // not be told the whole selection was repriced.
    const merged = mergeBulkPriceResponses([
      part([{ listing_id: "a", ok: true }]),
    ]);
    expect(merged.total).toBe(1);
    expect(merged.succeeded).toBe(1);
  });

  it("merges nothing into an empty, valid result", () => {
    // Cancelled before the first chunk returned.
    const merged = mergeBulkPriceResponses([]);
    expect(merged).toEqual({
      ok: true,
      total: 0,
      queued: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
  });
});
