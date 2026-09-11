// US-3376 AC3: a failed READ must never resolve a TanStack query as SUCCESS
// with an empty default.
//
// The five hooks here all had the same shape: `const { data } = await
// supabase...`, then build a map out of `data ?? []`. On a refusal that hands
// back an empty map with no error, so TanStack caches it as good data and never
// refetches. A cached empty map is worse than an error, because the error would
// have retried: the AutoLister queue paints blank columns and blank thumbnails,
// the review flags read "no draft needs review" beside a Publish button, and the
// composer presents the platform starting position as the seller's own saved
// listing defaults.
//
// The queryFn is run headless (useQuery is stubbed to return its options), which
// is the only way to assert "it rejected" rather than "an error was
// destructured".
import { beforeEach, describe, expect, it, vi } from "vitest";

let readError: unknown = null;
let rows: unknown[] = [];
let singleRow: unknown = null;

function resolveWith() {
  return Promise.resolve({
    data: readError ? null : rows,
    error: readError,
  });
}

function builder() {
  const self: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "limit", "is", "not"]) {
    self[k] = () => self;
  }
  self["maybeSingle"] = () =>
    Promise.resolve({ data: readError ? null : singleRow, error: readError });
  self["single"] = self["maybeSingle"];
  // Thenable, so `await chain` resolves with { data, error } and NEVER rejects.
  self["then"] = (onFulfilled: (v: unknown) => unknown) =>
    resolveWith().then(onFulfilled);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rest: { from: () => builder() },
    from(this: { rest: { from: () => unknown } }) {
      return this.rest.from();
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "11111111-1111-4111-8111-111111111111" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  useMutation: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));

const { useItemAttrs } = await import("@/pages/flipdesk/autolister/use-item-attrs");
const { useAutolisterItemMeta } = await import(
  "@/pages/flipdesk/autolister/use-item-meta"
);
const { useAutolisterListingReview } = await import(
  "@/pages/flipdesk/autolister/use-listing-review"
);
const { useAutolisterItemCovers } = await import(
  "@/pages/flipdesk/autolister/use-item-covers"
);
const { useSellerListingDefaults, PLATFORM_LISTING_DEFAULTS } = await import(
  "@/hooks/use-seller-listing-defaults"
);

type QueryOptions = { queryFn: () => Promise<unknown> };

const IDS = ["item-1", "item-2"];
const KEY = IDS.join(",");

// Each wrapper is NAMED as a hook so react-hooks/rules-of-hooks accepts the
// call (same trick as use-items-full.test.ts). react-query is mocked, so each of
// these is a plain function handing back its options object.
function useAttrsOptions(): QueryOptions {
  return useItemAttrs("batch-1", IDS) as unknown as QueryOptions;
}
function useMetaOptions(): QueryOptions {
  return useAutolisterItemMeta("batch-1", IDS, KEY) as unknown as QueryOptions;
}
function useReviewOptions(): QueryOptions {
  return useAutolisterListingReview("batch-1", IDS, KEY) as unknown as QueryOptions;
}
function useCoversOptions(): QueryOptions {
  return useAutolisterItemCovers("batch-1", IDS, KEY) as unknown as QueryOptions;
}
function useDefaultsOptions(): QueryOptions {
  return useSellerListingDefaults() as unknown as QueryOptions;
}

const READ_HOOKS: { name: string; options: () => QueryOptions }[] = [
  { name: "useItemAttrs", options: useAttrsOptions },
  { name: "useAutolisterItemMeta", options: useMetaOptions },
  { name: "useAutolisterListingReview", options: useReviewOptions },
  { name: "useAutolisterItemCovers", options: useCoversOptions },
  { name: "useSellerListingDefaults", options: useDefaultsOptions },
];

beforeEach(() => {
  readError = null;
  rows = [];
  singleRow = null;
});

describe("AC3: a refused read rejects instead of resolving empty", () => {
  for (const hook of READ_HOOKS) {
    it(`${hook.name} rejects when PostgREST refuses`, async () => {
      readError = {
        code: "42501",
        message: "permission denied for table",
      };
      await expect(hook.options().queryFn()).rejects.toMatchObject({ code: "42501" });
    });
  }

  it("useItemAttrs still builds its map on a real empty answer", async () => {
    rows = [];
    await expect(useAttrsOptions().queryFn()).resolves.toEqual({});
  });
});

describe("AC4: the seller listing defaults fallback direction, stated", () => {
  it("hands back the no-opinion defaults for a seller with no saved row", async () => {
    // An ABSENT row is a real answer and keeps the platform starting position:
    // no format, no duration, Best Offer off, no thresholds, no quantity. That
    // is the same safe direction use-seller-promo-defaults.ts takes with OFF.
    singleRow = null;
    const result = await useDefaultsOptions().queryFn();
    expect(result).toEqual(PLATFORM_LISTING_DEFAULTS);
    expect(PLATFORM_LISTING_DEFAULTS.default_best_offer_enabled).toBe(false);
    expect(PLATFORM_LISTING_DEFAULTS.default_best_offer_accept_pct).toBeNull();
  });

  it("does NOT hand back those defaults when the read was refused", async () => {
    // The bug: the composer presented the platform position as the seller's own
    // choices, and TanStack cached it.
    readError = { code: "42501", message: "permission denied for table users" };
    await expect(useDefaultsOptions().queryFn()).rejects.toMatchObject({
      code: "42501",
    });
  });
});
