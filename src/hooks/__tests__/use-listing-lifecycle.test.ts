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
