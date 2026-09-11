// US-3381 AC1 + AC4. The two recent-search RPCs.
//
// Both were wrapped in a try/catch and both dropped `error`. supabase.rpc
// RESOLVES with { data: null, error } -- it does not reject -- so the catch was
// dead for every failure except a dropped socket, and a permanently broken
// recent_searches RPC looked exactly like a seller who has never searched.
//
// The DIRECTION here is deliberate and unchanged: neither call is worth a toast
// (there is nothing the seller can do, and no wrong data is shown, only less of
// it). What changes is that the failure is now counted instead of swallowed.
//
// THE MOCK RESOLVES AND NEVER REJECTS, except in the one case that says so.
import { beforeEach, describe, expect, it, vi } from "vitest";

let rpcError: unknown = null;
let rpcRejects = false;
let rpcRows: { query: string }[] | null = null;
const rpcCalls: { fn: string; args: unknown }[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (rpcRejects) return Promise.reject(new Error("network down"));
      // Resolves. Never rejects. This is the whole point.
      return Promise.resolve({ data: rpcError ? null : rpcRows, error: rpcError });
    },
  },
}));

const captured: { err: unknown; action: unknown }[] = [];
vi.mock("@/lib/sentry", () => ({
  captureException: (err: unknown, ctx?: { extra?: { user_action?: string } }) => {
    captured.push({ err, action: ctx?.extra?.user_action });
  },
}));

const { fetchRecentSearches, recordSearch } = await import("@/lib/recent-searches");

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  rpcError = null;
  rpcRejects = false;
  rpcRows = null;
  rpcCalls.length = 0;
  captured.length = 0;
});

describe("fetchRecentSearches", () => {
  it("reports a RESOLVED refusal instead of reading it as no history", async () => {
    rpcError = { code: "42501", message: "permission denied for function recent_searches" };
    await expect(fetchRecentSearches(8)).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.action).toBe("read recent searches");
    expect(captured[0]!.err).toMatchObject({ code: "42501" });
  });

  it("still reports a real rejection, which is all the catch ever caught", async () => {
    rpcRejects = true;
    await expect(fetchRecentSearches(8)).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
  });

  it("stays silent and returns the terms when the RPC answers", async () => {
    rpcRows = [{ query: "carhartt" }, { query: "" }, { query: "levis" }];
    await expect(fetchRecentSearches(8)).resolves.toEqual(["carhartt", "levis"]);
    expect(captured).toEqual([]);
  });

  it("a genuinely empty history is not reported", async () => {
    rpcRows = [];
    await expect(fetchRecentSearches(8)).resolves.toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe("recordSearch", () => {
  it("reports a RESOLVED refusal on the fire-and-forget write", async () => {
    rpcError = { code: "42501", message: "permission denied for function record_search" };
    recordSearch("carhartt detroit");
    await flush();
    expect(rpcCalls.map((c) => c.fn)).toEqual(["record_search"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.action).toBe("record search term");
  });

  it("stays silent when the term records", async () => {
    recordSearch("carhartt detroit");
    await flush();
    expect(captured).toEqual([]);
  });

  it("does not call the RPC for a one-character term", async () => {
    recordSearch("c");
    await flush();
    expect(rpcCalls).toEqual([]);
  });
});
