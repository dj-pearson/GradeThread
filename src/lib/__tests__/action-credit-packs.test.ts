import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_CREDIT_PACKS,
  ACTION_CREDITS_LOW_BALANCE,
  FLIPDESK_PLANS,
} from "@/lib/constants";

// US-3138: the web's copy of the Action Credit pack table.
//
// This copy exists only for surfaces that render before a billing summary has
// loaded. The server's table is what a seller is actually charged from, so the
// two drifting means we advertise one price and take another. That is the kind
// of bug nobody reports as a bug, they just stop trusting the product.

// Read the edge table as TEXT rather than importing it. The edge is Deno with
// .ts import specifiers, which Vitest's resolver will not follow, and adding a
// path alias for one test would drag the whole edge module graph into the web
// build. Parsing four numbers out of the source is uglier and does the job.
//
// Resolved from process.cwd(), NOT from import.meta.url. Under Vitest
// import.meta.url is not a file: URL, so fileURLToPath throws "The URL must be
// of scheme file" -- which is a green-looking failure mode if the throw is ever
// caught. Vitest runs from the repo root.
const EDGE_TABLE = join(
  process.cwd(),
  "services/edge-functions/src/lib/action-credits.ts",
);
function edgePackTable(): Record<string, { credits: number; priceCents: number }> {
  const src = readFileSync(EDGE_TABLE, "utf8");
  const out: Record<string, { credits: number; priceCents: number }> = {};
  const re =
    /"(\d+)":\s*\{\s*key:\s*"(\d+)",\s*credits:\s*(\d+),\s*priceCents:\s*(\d+),/g;
  for (const m of src.matchAll(re)) {
    out[m[1]!] = { credits: Number(m[3]), priceCents: Number(m[4]) };
  }
  return out;
}

describe("Action Credit packs", () => {
  it("matches the edge table the checkout actually charges from", () => {
    const edge = edgePackTable();
    // Guard the guard: a regex that stops matching reads exactly like agreement.
    expect(Object.keys(edge)).toHaveLength(4);

    for (const pack of ACTION_CREDIT_PACKS) {
      expect(edge[pack.key], `edge table has no pack ${pack.key}`).toBeDefined();
      expect(edge[pack.key]!.credits).toBe(pack.credits);
      expect(edge[pack.key]!.priceCents).toBe(pack.priceCents);
    }
    expect(ACTION_CREDIT_PACKS).toHaveLength(Object.keys(edge).length);
  });

  it("keys the packs by their credit count, smallest first", () => {
    const credits = ACTION_CREDIT_PACKS.map((p) => p.credits);
    expect(credits).toEqual([...credits].sort((a, b) => a - b));
    for (const pack of ACTION_CREDIT_PACKS) {
      expect(String(pack.credits)).toBe(pack.key);
    }
  });

  it("never undercuts Pro's implied per-action rate", () => {
    // The same rule the edge test enforces, restated against the plan table
    // this file already has. If a re-price ever crosses it, topping up beats
    // upgrading on the pure per-action metric and the plan ladder inverts.
    const pro = FLIPDESK_PLANS.pro;
    const proRate = pro.priceMonthlyCents / pro.aiActionsPerMonth;
    for (const pack of ACTION_CREDIT_PACKS) {
      const rate = pack.priceCents / pack.credits;
      expect(
        rate,
        `pack ${pack.key} is ${rate.toFixed(2)}c/credit against Pro's ${proRate.toFixed(2)}c`,
      ).toBeGreaterThanOrEqual(proRate);
    }
  });

  it("carries no Stripe price ids", () => {
    // The rule the plan table above already states loudly: a client-side price
    // id sends a fake id into a live Checkout the first time it is adopted
    // somewhere the env vars are not inlined.
    const serialized = JSON.stringify(ACTION_CREDIT_PACKS);
    expect(serialized).not.toMatch(/price_/);
    expect(serialized).not.toMatch(/STRIPE_/);
  });

  it("agrees with the edge on when a balance is low", () => {
    const src = readFileSync(EDGE_TABLE, "utf8");
    const m = src.match(/LOW_BALANCE_THRESHOLD\s*=\s*(\d+)/);
    expect(m, "LOW_BALANCE_THRESHOLD not found on the edge").not.toBeNull();
    expect(Number(m![1])).toBe(ACTION_CREDITS_LOW_BALANCE);
  });
});
