// Durable guard: what the web ADVERTISES must equal what the edge ENFORCES.
//
// The web plan cards render from FLIPDESK_PLANS (src/lib/constants.ts); the edge
// enforces caps from PlanConfig (services/edge-functions/src/lib/pricing-config.ts
// → plan-gate.ts getLimit). They are two separate declarations in two projects
// that cannot import each other, so tsc links neither. If they drift, the
// pricing page advertises a limit the server does not grant — the exact
// advertised-vs-enforced defect US-2123 found on the iOS paywall (Pro sold as
// "1,000 AI actions", enforced at 750), here for the web/edge pair.
//
// This asserts every shared numeric cap agrees for every plan, so that drift
// fails the build. Currently clean; negative-verified.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FLIPDESK_PLANS } from "@/lib/constants";

const PRICING_CONFIG = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/pricing-config.ts",
);

const PLANS = ["free", "starter", "pro", "business"] as const;
const SHARED_CAPS = [
  "activeListingCap",
  "aiActionsPerMonth",
  "marketplacesCap",
  "includedStandardGradesPerMonth",
] as const;

/** Parse the edge PlanConfig numeric caps per plan from the source file. */
function edgePlanCaps(): Record<string, Record<string, number>> {
  const src = readFileSync(PRICING_CONFIG, "utf8");
  const out: Record<string, Record<string, number>> = {};
  for (const plan of PLANS) {
    // The block from `<plan>: {` up to its closing `},`.
    const start = src.search(new RegExp(`\\b${plan}:\\s*\\{`));
    if (start < 0) throw new Error(`plan ${plan} not found in pricing-config.ts`);
    const block = src.slice(start, src.indexOf("},", start));
    const caps: Record<string, number> = {};
    for (const cap of SHARED_CAPS) {
      const m = block.match(new RegExp(`${cap}:\\s*(-?\\d+)`));
      if (m) caps[cap] = Number(m[1]);
    }
    out[plan] = caps;
  }
  return out;
}

describe("web advertised plan caps ↔ edge enforced plan caps", () => {
  const edge = edgePlanCaps();

  for (const plan of PLANS) {
    for (const cap of SHARED_CAPS) {
      it(`${plan}.${cap} agrees between the web and the edge`, () => {
        const webVal = (FLIPDESK_PLANS[plan] as Record<string, unknown>)[cap];
        const edgeVal = edge[plan][cap];
        expect(edgeVal, `edge pricing-config.ts is missing ${plan}.${cap}`).not.toBeUndefined();
        expect(
          webVal,
          `advertised (web FLIPDESK_PLANS) vs enforced (edge PlanConfig) drift on ` +
            `${plan}.${cap} — the pricing page would show a limit the server does not enforce`,
        ).toBe(edgeVal);
      });
    }
  }
});
