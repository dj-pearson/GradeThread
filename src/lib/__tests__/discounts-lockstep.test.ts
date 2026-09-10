// US-3299 — the two discount resolvers must stay identical.
//
// src/lib/discounts.ts (browser) and
// services/edge-functions/src/lib/discount-campaigns.ts (Deno) implement the same
// arithmetic twice. They cannot share a file: one is resolved through Vite's `@/`
// alias, the other needs explicit `.ts` specifiers.
//
// Two tests exist on the pair. The vector tests on each side prove each is
// individually correct against the same inputs. This one proves the SOURCES have
// not diverged in a way those vectors happen not to cover — a fifth target kind
// added on one side, a tie-break flipped, a rounding mode changed.
//
// The failure it exists to prevent is specific and expensive: the pricing card
// says $23.20, checkout resolves differently and charges $29, and nothing errors.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve(process.cwd(), "src/lib/discounts.ts");
const EDGE = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/discount-campaigns.ts",
);

/**
 * A function body with comments and whitespace stripped, so a reworded comment on
 * one side is not a failure but a changed expression is.
 */
function normalizedBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`${signature} not found`);
  // Walk braces from the first `{` after the signature to its match.
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return src
    .slice(open, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Every function whose behavior a price depends on. formatEndsLabel is excluded
// deliberately: the browser formats in the viewer's locale and the edge pins
// en-US, which is a real and intended difference.
const MIRRORED = [
  "export function isCampaignLive(",
  "export function campaignMatches(",
  "export function discountedCents(",
  "export function formatDiscountLabel(",
  "export function resolveDiscount(",
  "function beats(",
  "export function liveCampaigns(",
] as const;

describe("web and edge discount resolvers stay in lockstep", () => {
  const web = readFileSync(WEB, "utf8");
  const edge = readFileSync(EDGE, "utf8");

  for (const sig of MIRRORED) {
    it(`${sig.replace("export function ", "").replace("function ", "").replace("(", "")} is identical on both sides`, () => {
      expect(
        normalizedBody(edge, sig),
        `${sig} differs between src/lib/discounts.ts and the edge copy. A card can ` +
          "now advertise a price checkout will not honor. Port the change to both.",
      ).toBe(normalizedBody(web, sig));
    });
  }

  it("both sides know the same target kinds", () => {
    const kinds = (src: string) => {
      const at = src.indexOf("export type DiscountTargetKind =");
      const block = src.slice(at, src.indexOf(";", at));
      return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    };
    expect(
      kinds(edge),
      "a target kind exists on one side only — a campaign aimed at it would be " +
        "shown but not charged, or charged but not shown",
    ).toEqual(kinds(web));
  });

  it("the guard is looking at real files", () => {
    // Cheap self-check: if either path stops resolving, every case above would
    // throw rather than compare, and a thrown test is easy to misread as flaky.
    expect(web.length).toBeGreaterThan(2000);
    expect(edge.length).toBeGreaterThan(2000);
  });
});
