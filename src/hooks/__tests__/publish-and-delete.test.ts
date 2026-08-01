// US-2178 AC1: the two listings-table actions with no coverage — publish, and
// hard delete.
//
// Both are one-way. Publishing spends an insertion fee and puts a garment on
// sale; deleting removes an item, its photos, its drafts and its listing
// records for good. Neither had a test, and the interesting part of each is not
// the happy path — it is what the seller is TOLD when the server refuses:
//
//   • publish returns 422 with a `blockers` array. If those blockers are
//     dropped, the seller sees "Publish failed." and has no idea which field to
//     fix, on a batch of 200 where the answer differs per row.
//   • delete returns 409 with a `code` when the item has a live listing or a
//     recorded sale. The caller branches on that code; a swallowed one turns a
//     protective refusal into a generic error.
//
// fetch / edgeFetch are mocked at the module boundary and react-query is stubbed
// to hand back its options, so each mutationFn runs headless — no new harness.

import { beforeEach, describe, expect, it, vi } from "vitest";

let nextStatus = 200;
let nextBody: unknown = { ok: true };
const fetchCalls: { url: string; init?: RequestInit }[] = [];

const fakeResponse = () =>
  ({
    ok: nextStatus >= 200 && nextStatus < 300,
    status: nextStatus,
    json: () =>
      nextBody === undefined
        ? Promise.reject(new Error("not json"))
        : Promise.resolve(nextBody),
  }) as unknown as Response;

vi.stubGlobal(
  "fetch",
  vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return Promise.resolve(fakeResponse());
  }),
);

const edgeCalls: { path: string; init?: { method?: string } }[] = [];
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (path: string, init?: { method?: string }) => {
    edgeCalls.push({ path, init });
    return Promise.resolve(fakeResponse());
  },
}));

vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://functions.test.invalid" }));
vi.mock("@/lib/auth-token", () => ({ getFreshAccessToken: () => Promise.resolve("t") }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));
vi.mock("@/stores/auth-store", () => {
  const state = { user: { id: "u1" }, activeWorkspaceOwnerId: null };
  return {
    useAuthStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  useMutation: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { usePublishToEbay } = await import("@/hooks/use-ebay");
const { useDeleteItem } = await import("@/hooks/use-items-full");

type MutationLike<V> = { mutationFn: (vars: V) => Promise<unknown> };
const run = <V,>(hook: () => unknown, vars: V) =>
  (hook() as MutationLike<V>).mutationFn(vars);

beforeEach(() => {
  fetchCalls.length = 0;
  edgeCalls.length = 0;
  nextStatus = 200;
  nextBody = { ok: true };
});

describe("publish", () => {
  it("posts the item to the push endpoint", async () => {
    nextBody = { ok: true };
    await run(usePublishToEbay, { itemId: "i1" });
    expect(fetchCalls[0]?.url).toBe(
      "https://functions.test.invalid/api/flipdesk/ebay/listings/push",
    );
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      inventory_item_id: "i1",
    });
  });

  it("only sends relist when asked", async () => {
    // relist=true ends a live listing first and publishes a NEW one with a new
    // item number. Sending it by default would silently churn item numbers and
    // reset every listing's search standing.
    nextBody = { ok: true };
    await run(usePublishToEbay, { itemId: "i1" });
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).not.toHaveProperty("relist");

    await run(usePublishToEbay, { itemId: "i1", relist: true });
    expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({
      inventory_item_id: "i1",
      relist: true,
    });
  });

  it("surfaces the 422 blockers, not just a generic failure", async () => {
    // This is the whole point of the error path. On a bulk publish the seller
    // needs to know WHICH field failed on WHICH row; "Publish failed." sends
    // them to open 200 items one at a time.
    nextStatus = 422;
    nextBody = {
      ok: false,
      detail: "Listing is not ready.",
      blockers: ["Missing a shipping policy", "No category selected"],
    };
    await expect(run(usePublishToEbay, { itemId: "i1" })).rejects.toThrow(
      "Listing is not ready.\nMissing a shipping policy\nNo category selected",
    );
  });

  it("falls back to the error field when there is no detail", async () => {
    nextStatus = 400;
    nextBody = { ok: false, error: "eBay rejected the offer." };
    await expect(run(usePublishToEbay, { itemId: "i1" })).rejects.toThrow(
      "eBay rejected the offer.",
    );
  });

  it("treats ok:false on a 200 as a failure", async () => {
    // A server that answers 200 with ok:false is still refusing. Trusting the
    // status alone would report a publish that never happened.
    nextStatus = 200;
    nextBody = { ok: false, error: "Nothing to publish." };
    await expect(run(usePublishToEbay, { itemId: "i1" })).rejects.toThrow(
      "Nothing to publish.",
    );
  });

  it("still names something when the body is unreadable", async () => {
    nextStatus = 502;
    nextBody = undefined;
    await expect(run(usePublishToEbay, { itemId: "i1" })).rejects.toThrow(
      "Publish failed.",
    );
  });
});

describe("hard delete", () => {
  it("targets the item delete route with the id encoded", async () => {
    nextBody = { ok: true, item_id: "i1" };
    await run(useDeleteItem, { itemId: "a/b" });
    expect(edgeCalls[0]?.path).toBe("/api/flipdesk/listings/item/a%2Fb");
    expect(edgeCalls[0]?.init?.method).toBe("DELETE");
  });

  it("carries the 409 guard code so the caller can explain the refusal", async () => {
    // The server refuses an item with a live listing or a recorded sale. That
    // is a protective answer, not a fault, and the code is how the UI tells the
    // two apart.
    nextStatus = 409;
    nextBody = { error: "This item still has a live listing.", code: "has_live_listing" };
    await run(useDeleteItem, { itemId: "i1" }).catch(
      (e: Error & { status?: number; code?: string }) => {
        expect(e.message).toBe("This item still has a live listing.");
        expect(e.status).toBe(409);
        expect(e.code).toBe("has_live_listing");
      },
    );
    expect.assertions(3);
  });

  it("names a fallback when the server sends no message", async () => {
    nextStatus = 500;
    nextBody = {};
    await expect(run(useDeleteItem, { itemId: "i1" })).rejects.toThrow("Delete failed.");
  });

  it("returns the deleted id on success", async () => {
    nextBody = { ok: true, item_id: "i1" };
    await expect(run(useDeleteItem, { itemId: "i1" })).resolves.toEqual({
      ok: true,
      item_id: "i1",
    });
  });
});
