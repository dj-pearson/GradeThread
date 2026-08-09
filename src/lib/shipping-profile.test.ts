// US-2417 AC1 — the browser half of the encrypted shipping profile.
//
// Three properties matter here, and each one has a failure that is invisible
// until a real seller hits it:
//
//   1. skipWorkspaceHeader. Every other edge call sends X-Workspace-Owner so a
//      member can act inside someone else's workspace. This endpoint is the
//      caller's OWN account row — a manager in A's workspace must not read A's
//      home address — so the header must not go out at all.
//   2. The server's error text. The edge answers 503 with a message written for
//      the seller when a decrypt fails; swallowing it turns "your details could
//      not be unlocked, support has been notified" into a blank form, which
//      invites them to re-type an address that is already stored.
//   3. Absent means null, never the string "null" or undefined — the fields feed
//      controlled inputs and a stray undefined flips one to uncontrolled.

import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));

const {
  SHIPPING_PROFILE_QUERY_KEY,
  fetchShippingProfile,
  isShipFromComplete,
  saveShippingProfile,
} = await import("./shipping-profile");

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

const ADDRESS = {
  line1: "412 Wilder Street",
  city: "Portland",
  state: "OR",
  postal_code: "97214",
  country: "US",
};

beforeEach(() => {
  edgeFetch.mockReset();
});

describe("fetchShippingProfile", () => {
  it("calls the account endpoint and returns the decrypted profile", async () => {
    edgeFetch.mockResolvedValue(
      ok({ business_name: "Wilder Vintage", business_phone: "503-555-0148", ship_from_address: ADDRESS }),
    );
    const profile = await fetchShippingProfile();
    expect(edgeFetch).toHaveBeenCalledWith(
      "/api/account/shipping-profile",
      expect.objectContaining({ skipWorkspaceHeader: true }),
    );
    expect(profile.ship_from_address).toEqual(ADDRESS);
    expect(profile.business_phone).toBe("503-555-0148");
  });

  it("NEVER sends the workspace header", async () => {
    // The whole point: a workspace member must not read the owner's address.
    edgeFetch.mockResolvedValue(ok({}));
    await fetchShippingProfile();
    const opts = edgeFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.skipWorkspaceHeader).toBe(true);
  });

  it("normalizes an empty profile to nulls, not undefined", async () => {
    edgeFetch.mockResolvedValue(ok({}));
    const profile = await fetchShippingProfile();
    expect(profile).toEqual({
      business_name: null,
      business_phone: null,
      ship_from_address: null,
    });
  });

  it("surfaces the server's own message on a decrypt failure", async () => {
    edgeFetch.mockResolvedValue(
      fail(503, { error: "Your business details could not be unlocked. Support has been notified." }),
    );
    await expect(fetchShippingProfile()).rejects.toThrow(/could not be unlocked/);
  });

  it("falls back to a readable message when the body carries none", async () => {
    edgeFetch.mockResolvedValue(fail(500, {}));
    await expect(fetchShippingProfile()).rejects.toThrow(/Could not load/);
  });
});

describe("saveShippingProfile", () => {
  it("PUTs the three fields and returns what the server echoed", async () => {
    edgeFetch.mockResolvedValue(
      ok({ business_name: "Wilder Vintage", business_phone: "503-555-0148", ship_from_address: ADDRESS }),
    );
    const saved = await saveShippingProfile({
      business_name: "Wilder Vintage",
      business_phone: "503-555-0148",
      ship_from_address: ADDRESS,
    });
    const [path, opts] = edgeFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/account/shipping-profile");
    expect(opts.method).toBe("PUT");
    expect(opts.skipWorkspaceHeader).toBe(true);
    expect(opts.json).toEqual({
      business_name: "Wilder Vintage",
      business_phone: "503-555-0148",
      ship_from_address: ADDRESS,
    });
    expect(saved.ship_from_address).toEqual(ADDRESS);
  });

  it("sends empty strings rather than nulls for the cleared text fields", async () => {
    // The route trims and treats "" as cleared. A null would read as
    // "not provided" if the handler ever grows a partial-update branch, and the
    // two must not be ambiguous at the wire.
    edgeFetch.mockResolvedValue(ok({}));
    await saveShippingProfile({
      business_name: null,
      business_phone: null,
      ship_from_address: null,
    });
    const opts = edgeFetch.mock.calls[0]![1] as { json: Record<string, unknown> };
    expect(opts.json.business_name).toBe("");
    expect(opts.json.business_phone).toBe("");
    expect(opts.json.ship_from_address).toBeNull();
  });

  it("surfaces the server's message when the save cannot be secured", async () => {
    edgeFetch.mockResolvedValue(
      fail(503, { error: "Your business details could not be saved securely. Support has been notified." }),
    );
    await expect(
      saveShippingProfile({ business_name: null, business_phone: null, ship_from_address: null }),
    ).rejects.toThrow(/could not be saved securely/);
  });
});

describe("isShipFromComplete", () => {
  it("needs line1, city, state and postal_code — country is defaulted", () => {
    expect(isShipFromComplete(ADDRESS)).toBe(true);
    expect(isShipFromComplete({ ...ADDRESS, state: "" })).toBe(false);
    expect(isShipFromComplete({ postal_code: "97214" })).toBe(false);
    expect(isShipFromComplete(null)).toBe(false);
    expect(isShipFromComplete(undefined)).toBe(false);
  });

  it("treats whitespace as empty", () => {
    expect(isShipFromComplete({ ...ADDRESS, line1: "   " })).toBe(false);
  });
});

describe("the query key", () => {
  it("is shared, so one save invalidates every reader", () => {
    // Settings and the eBay location dialog both read this. Two different keys
    // would leave the dialog prefilling a stale address after a save.
    expect(SHIPPING_PROFILE_QUERY_KEY).toEqual(["account", "shipping-profile"]);
  });
});
