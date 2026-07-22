// Durable guard: buyer plan allowances the edge ENFORCES must equal what the web
// ADVERTISES — the buyer-plan analog of plan-limits-parity.test.ts.
//
// The web renders buyer plan cards from BUYER_PLANS (src/lib/constants.ts); the
// edge enforces the same allowances from BUYER_PLAN_ENTITLEMENTS.allowances
// (services/edge-functions/src/lib/buyer-plans.ts → buyer-entitlements.ts). Its
// own comment says the two are derived "from the identical BUYER_PLANS config so
// client and edge agree" — but nothing across the project boundary checks it. A
// drift means the buyer pricing page advertises an allowance the server does not
// grant, the advertised-vs-enforced defect class from US-2123.
//
// Only the NUMERIC allowances are compared: both declare those flat, whereas the
// web feature list is display copy and the edge gateFlags are booleans, so those
// have no value-level parity to assert here. Currently clean; negative-verified.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUYER_PLANS } from "@/lib/constants";

const BUYER_PLANS_EDGE = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/buyer-plans.ts",
);

const PLANS = ["free", "guard", "connoisseur"] as const;
const ALLOWANCES = [
  "extensionChecksPerMonth",
  "authenticityCreditsPerMonth",
  "videoGradeCreditsPerMonth",
  "activeAlertsCap",
  "portfolioItemCap",
] as const;

// Buyer feature flags the web advertises (flat booleans on BUYER_PLANS) and the
// edge enforces (BUYER_PLAN_ENTITLEMENTS.gateFlags). Same key names, so a value
// drift means a buyer is sold a capability (e.g. purchaseGuarantee) the server
// gate denies — the advertised-vs-enforced class, and for the guarantee flag a
// trust/legal one. (wardrobePortfolio/demandBoard/prioritySupport are edge-only
// enforcement, not advertised here, so they're excluded.)
const BUYER_GATE_FLAGS = [
  "extensionSecondOpinion",
  "discrepancyScoring",
  "priceFairness",
  "conditionAlerts",
  "fitPrediction",
  "authenticityAddon",
  "videoGrading",
  "rewards",
  "trustScore",
  "purchaseGuarantee",
] as const;

/** Parse each plan's `gateFlags` booleans from the edge source. */
function edgeGateFlags(): Record<string, Record<string, boolean>> {
  const src = readFileSync(BUYER_PLANS_EDGE, "utf8");
  const out: Record<string, Record<string, boolean>> = {};
  for (const plan of PLANS) {
    const planStart = src.search(new RegExp(`\\b${plan}:\\s*\\{`));
    if (planStart < 0) throw new Error(`buyer plan ${plan} not found`);
    const flagsStart = src.indexOf("gateFlags:", planStart);
    if (flagsStart < 0) throw new Error(`gateFlags for ${plan} not found`);
    const block = src.slice(flagsStart, src.indexOf("}", flagsStart));
    const flags: Record<string, boolean> = {};
    for (const flag of BUYER_GATE_FLAGS) {
      const m = block.match(new RegExp(`${flag}:\\s*(true|false)`));
      if (m) flags[flag] = m[1] === "true";
    }
    out[plan] = flags;
  }
  return out;
}

/** Parse each plan's `allowances` numeric caps from the edge source. */
function edgeAllowances(): Record<string, Record<string, number>> {
  const src = readFileSync(BUYER_PLANS_EDGE, "utf8");
  const out: Record<string, Record<string, number>> = {};
  for (const plan of PLANS) {
    const planStart = src.search(new RegExp(`\\b${plan}:\\s*\\{`));
    if (planStart < 0) throw new Error(`buyer plan ${plan} not found`);
    const allowStart = src.indexOf("allowances:", planStart);
    if (allowStart < 0) throw new Error(`allowances for ${plan} not found`);
    const block = src.slice(allowStart, src.indexOf("}", allowStart));
    const caps: Record<string, number> = {};
    for (const cap of ALLOWANCES) {
      const m = block.match(new RegExp(`${cap}:\\s*(-?\\d+)`));
      if (m) caps[cap] = Number(m[1]);
    }
    out[plan] = caps;
  }
  return out;
}

describe("buyer web advertised allowances ↔ edge enforced allowances", () => {
  const edge = edgeAllowances();

  for (const plan of PLANS) {
    for (const cap of ALLOWANCES) {
      it(`${plan}.${cap} agrees between the web and the edge`, () => {
        const webVal = (BUYER_PLANS[plan] as unknown as Record<string, unknown>)[cap];
        const edgeVal = edge[plan]?.[cap];
        expect(edgeVal, `edge buyer-plans.ts is missing ${plan}.${cap}`).not.toBeUndefined();
        expect(
          webVal,
          `advertised (web BUYER_PLANS) vs enforced (edge allowances) drift on ` +
            `${plan}.${cap} — the buyer pricing page would show an allowance the server does not grant`,
        ).toBe(edgeVal);
      });
    }
  }
});

describe("buyer web advertised feature flags ↔ edge enforced gateFlags", () => {
  const edge = edgeGateFlags();

  for (const plan of PLANS) {
    for (const flag of BUYER_GATE_FLAGS) {
      it(`${plan}.${flag} agrees between the web and the edge`, () => {
        const webFlags =
          (BUYER_PLANS[plan] as unknown as { gateFlags?: Record<string, boolean> })
            .gateFlags ?? {};
        const webVal = webFlags[flag];
        const edgeVal = edge[plan]?.[flag];
        expect(edgeVal, `edge buyer-plans.ts is missing ${plan}.gateFlags.${flag}`).not
          .toBeUndefined();
        expect(
          webVal,
          `advertised (web BUYER_PLANS) vs enforced (edge gateFlags) drift on ${plan}.${flag} ` +
            `— the buyer pricing page and the server disagree on this capability`,
        ).toBe(edgeVal);
      });
    }
  }
});
