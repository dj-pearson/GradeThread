import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * US-3414: the SKU carry rule has exactly one home, and it is Postgres.
 *
 * `public.flipdesk_sku_advance` decides when J9999 becomes K0000. A second copy
 * of that rule in TypeScript, Swift or Kotlin will drift from it, and the drift
 * is invisible until two items in one tenant get the same SKU -- at which point
 * the unique index rejects a save the seller cannot explain.
 *
 * This repo has already paid for exactly this shape once: the grading rounding
 * rule lives at three sites and has to be changed in lockstep. The settings
 * preview calls the `flipdesk_sku_preview` RPC instead of computing anything,
 * precisely so there is no second site here.
 *
 * `.pathname` on an import.meta.url is relative on Linux; fileURLToPath is the
 * portable form and the reason this file uses it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROOTS = ["src", "services/edge-functions/src", "ios", "android"];
const EXTS = [".ts", ".tsx", ".swift", ".kt"];
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git", ".gradle", "Pods"]);

/**
 * Names that only appear when somebody has written a second odometer. Matching
 * on the declaration rather than on a call keeps a legitimate RPC invocation
 * (`supabase.rpc("flipdesk_sku_advance", ...)`) from tripping it.
 */
const BANNED: readonly { re: RegExp; what: string }[] = [
  { re: /\bfunction\s+advanceSku\b/, what: "advanceSku()" },
  { re: /\bfunction\s+renderSku\b/, what: "renderSku()" },
  { re: /\bconst\s+advanceSku\s*[:=]/, what: "advanceSku" },
  { re: /\bconst\s+renderSku\s*[:=]/, what: "renderSku" },
  { re: /\bfunc\s+advanceSku\b/, what: "advanceSku (Swift)" },
  { re: /\bfun\s+advanceSku\b/, what: "advanceSku (Kotlin)" },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // ios/ and android/ are not present in every checkout or CI image.
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

describe("the SKU odometer has exactly one home", () => {
  it("is not reimplemented outside Postgres", () => {
    const offenders: string[] = [];
    for (const r of ROOTS) {
      for (const file of walk(join(ROOT, r))) {
        if (file.endsWith("sku-odometer-single-home.test.ts")) continue;
        const text = readFileSync(file, "utf8");
        for (const { re, what } of BANNED) {
          if (re.test(text)) {
            offenders.push(`${file.slice(ROOT.length + 1).replace(/\\/g, "/")} (${what})`);
          }
        }
      }
    }
    expect(
      offenders,
      "The carry rule lives only in public.flipdesk_sku_advance (migration " +
        "00802). Call the flipdesk_sku_preview RPC instead of porting it.",
    ).toEqual([]);
  });

  it("scans a tree that actually contains source, so a silent no-op fails", () => {
    // A guard that walks nothing passes forever. This pins that the walk found
    // real files, which is the failure mode the repo has been bitten by before.
    const seen = walk(join(ROOT, "src"));
    expect(seen.length).toBeGreaterThan(100);
  });
});
