import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_STATE_PRECEDENCE, deriveChannelState } from "@/lib/channel-state";

// US-3454: ios/GradeThread/Marketplaces/ChannelState.swift is a hand-port of
// deriveChannelState. Swift cannot be compiled here, so the precedence table
// is compared as text, the way ios-cross-listing-registry.test.ts pins the
// registry: a reorder on either side fails on every machine.

const SWIFT_PATH = resolve(__dirname, "../../ios/GradeThread/Marketplaces/ChannelState.swift");

function parseSwiftPrecedence(source: string): string[] {
  const start = source.indexOf("static let precedence: [String] = [");
  expect(start, "ChannelState.precedence has been renamed or removed").toBeGreaterThan(-1);
  // The type annotation carries its own brackets; the list opens at "= [".
  const open = source.indexOf("= [", start);
  const end = source.indexOf("]", open + 3);
  const body = source.slice(open, end);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("US-3454: the iOS channel-state port mirrors src/lib/channel-state.ts", () => {
  const source = readFileSync(SWIFT_PATH, "utf8");
  const swift = parseSwiftPrecedence(source);

  it("parses a real list rather than passing on an empty match", () => {
    expect(swift.length).toBeGreaterThan(5);
  });

  it("orders the states exactly as the TypeScript does", () => {
    expect(swift).toEqual([...CHANNEL_STATE_PRECEDENCE]);
  });

  it("declares every state the TypeScript union has, as a Swift case", () => {
    for (const state of CHANNEL_STATE_PRECEDENCE) {
      const swiftCase = state === "delist_queued" ? 'case delistQueued = "delist_queued"' : `case ${state}`;
      expect(source, state).toContain(swiftCase);
    }
  });

  it("the TypeScript derivation really answers in that order for a row with everything at once", () => {
    // One row, one pending delist and one pending list: delist wins. Drop the
    // delist and the list wins. Drop the list and the row's own status wins.
    const row = {
      id: "l1",
      platform: "poshmark",
      listing_status: "active",
      listing_url: "https://poshmark.com/listing/1",
      delist_requested_at: null,
      platform_fields: null,
      updated_at: "2026-09-21T00:00:00Z",
    };
    const job = (kind: "list" | "delist", status: "queued" | "failed") => ({
      id: `${kind}-${status}`,
      kind,
      platform: "poshmark",
      inventory_item_id: "i1",
      listing_id: "l1",
      payload: {},
      status,
      attempts: 0,
      source: "web",
      claimed_at: null,
      completed_at: null,
      result: null,
      expires_at: "2026-09-30T00:00:00Z",
      created_at: "2026-09-21T00:00:00Z",
    });
    expect(deriveChannelState([row], [job("delist", "queued"), job("list", "queued")], "poshmark").state).toBe("delist_queued");
    expect(deriveChannelState([row], [job("list", "queued")], "poshmark").state).toBe("queued");
    expect(deriveChannelState([row], [job("list", "failed")], "poshmark").state).toBe("live");
    expect(deriveChannelState([{ ...row, listing_status: "draft" }], [job("list", "failed")], "poshmark").state).toBe("failed");
  });
});
