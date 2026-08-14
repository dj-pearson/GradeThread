import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-2515. The bulk-upload paywall — the one screen whose entire job is telling
// a seller what to buy — read "Available on Professional & Enterprise". Neither
// is a plan you can purchase. `professional` and `enterprise` are LEGACY
// `user_plan` values that a shim maps onto pro and business
// (src/lib/constants.ts:675); the live tiers are Free, Starter, Pro, Business.
// The same mistake was on /developers, which quoted an API rate limit for an
// "Enterprise" tier the server's own table has never had.
//
// Guard the class: no user-facing copy may name a retired tier. Comments and
// the shim that does the mapping are exempt — they have to name them.

const SCAN_ROOTS = ["src/pages", "src/components"];
const DEAD_TIERS = ["Professional", "Enterprise"];

/** Files that legitimately contain the words for reasons unrelated to plans. */
const EXEMPT = new Set([
  // "Professional cleaning" / "Professional reweaving" — garment repair copy.
  "src/lib/repair-triage.ts",
  "src/lib/seo/flaw-library.ts",
  "src/pages/marketing/design-vs-damage.tsx",
]);

function scan(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (/\.tsx?$/.test(e.name)) out.push(p.split(sep).join("/"));
    }
  };
  for (const r of SCAN_ROOTS) walk(resolve(process.cwd(), r));
  return out.map((p) => p.slice(p.indexOf("src/")));
}

/** Strip comments so an explanation of the bug is not read as the bug. */
function code(src: string): string {
  return src
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("no user-facing copy names a retired plan tier (US-2515)", () => {
  it("found files to scan", () => {
    expect(scan().length).toBeGreaterThan(100);
  });

  it("Professional and Enterprise appear in no page or component copy", () => {
    const offenders: string[] = [];
    for (const rel of scan()) {
      if (EXEMPT.has(rel)) continue;
      const src = code(readFileSync(resolve(process.cwd(), rel), "utf8"));
      for (const tier of DEAD_TIERS) {
        // Word-boundary match, and only where it reads as a plan name: either
        // quoted copy or JSX text. Substring hits like "Professionally" are out.
        if (new RegExp(`\\b${tier}\\b`).test(src)) {
          offenders.push(`${rel} — "${tier}"`);
        }
      }
    }
    expect(
      [...new Set(offenders)],
      "these name a tier nobody can buy. The live plans are Free, Starter, Pro " +
        "and Business — build the copy from FLIPDESK_PLANS:\n  " +
        [...new Set(offenders)].join("\n  "),
    ).toEqual([]);
  });

  it("the bulk-upload gate builds its copy from FLIPDESK_PLANS", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/pages/bulk-submission.tsx"),
      "utf8",
    );
    // The names must come from the plan table, not a string literal, so a
    // rename can never strand this screen again.
    expect(src).toMatch(/ALLOWED_PLANS\.map\(\(p\) => FLIPDESK_PLANS\[p\]\.name\)/);
    // And the gate list itself must be typed against the live plan keys.
    expect(src).toMatch(/const ALLOWED_PLANS: FlipdeskPlanKey\[\]/);
  });

  it("the public API rate table matches the server's, row for row", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/developers.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(
        process.cwd(),
        "services/edge-functions/src/middleware/api-v1-rate.ts",
      ),
      "utf8",
    );
    // Every read/write pair the page advertises must exist in the server table.
    const advertised = [...page.matchAll(/read: (\d+), write: (\d+)/g)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    expect(advertised.length).toBeGreaterThan(2);
    const granted = new Set(
      [...server.matchAll(/read: (\d+), write: (\d+)/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    );
    const unbacked = advertised.filter((a) => !granted.has(a));
    expect(
      unbacked,
      "/developers advertises API capacity the server never grants:\n  " +
        unbacked.join("\n  "),
    ).toEqual([]);
  });
});
