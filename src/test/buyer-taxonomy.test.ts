import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GARMENT_CATEGORIES } from "@/lib/constants";
import {
  BUYER_CATEGORY_OPTIONS,
  SIZE_GROUPS,
  isMatchableCategory,
  normalizeCategories,
  readLegacySizes,
  readSizeBuckets,
  writeSizeBuckets,
} from "@/lib/buyer-taxonomy";

// US-2552. Four buyer surfaces write category criteria and each did it its own
// way: onboarding had 13 hardcoded chips, settings a different hardcoded 19, and
// the demand board and saved-search alerts took free text. Matching compares
// them to submissions.garment_category with case-insensitive EXACT equality, so
// "jackets" is not a near miss — it is a criterion that never matches anything
// and never says so.

const ONBOARDING = "src/pages/buyer/onboarding.tsx";
const SETTINGS = "src/pages/buyer/settings.tsx";
const DEMAND = "src/pages/buyer/demand.tsx";
const ALERTS = "src/pages/buyer/alerts.tsx";
const EDGE_BOARD = "services/edge-functions/src/lib/demand-board.ts";
const EDGE_WANTS = "services/edge-functions/src/routes/buyer-wants.ts";
const MATCHER = "services/edge-functions/src/lib/condition-alerts.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("one category vocabulary (US-2552 AC1, AC2)", () => {
  it("is the taxonomy matching actually compares against", () => {
    // The premise, verified rather than assumed: matching is exact equality
    // against garment_category, so anything outside the list is dead criteria.
    const matcher = read(MATCHER);
    expect(matcher).toContain("search.categories.some((x) => lc(x) === cat)");
    expect(BUYER_CATEGORY_OPTIONS).toEqual(
      GARMENT_CATEGORIES.filter((c) => c !== "other"),
    );
  });

  it("excludes the grader's fallback bucket", () => {
    // `other` means "we could not classify this". As a shopping interest it
    // would match miscellany rather than anything the buyer meant.
    expect(BUYER_CATEGORY_OPTIONS).not.toContain("other");
    expect(isMatchableCategory("other")).toBe(false);
  });

  it("covers what the old hardcoded lists missed", () => {
    // The 13 in onboarding were all real values, so the finding's worst case was
    // wrong — but blouse, shorts, sandals, hat, belt, scarf, neckwear and gloves
    // were unreachable, and the list did not grow when the taxonomy did.
    for (const c of [
      "blouse", "shorts", "sandals", "hat", "belt", "scarf", "neckwear", "gloves",
    ]) {
      expect(BUYER_CATEGORY_OPTIONS, c).toContain(c);
    }
  });

  it("drops what can never match, case-insensitively", () => {
    expect(normalizeCategories(["Jacket", "JEANS"])).toEqual(["jacket", "jeans"]);
    expect(normalizeCategories(["jackets", "sneaker", ""])).toEqual([]);
    expect(normalizeCategories(["jacket", "jacket"])).toEqual(["jacket"]);
  });

  it("no buyer surface keeps its own list any more", () => {
    for (const rel of [ONBOARDING, SETTINGS, DEMAND, ALERTS]) {
      const src = read(rel);
      expect(src, rel).toContain("CategoryPicker");
      // The tell of a private copy: a literal array of garment names.
      expect(src, rel).not.toMatch(/const CATEGORY_OPTIONS = \[/);
      expect(src, rel).not.toMatch(/"t-shirt",\s*"shirt"/);
    }
  });
});

describe("the server refuses a category that cannot match (US-2552 AC2)", () => {
  const board = read(EDGE_BOARD);

  it("the edge list matches the client list exactly", () => {
    // Two trees, no shared module graph, so the list is duplicated on purpose.
    // Duplicated and DIVERGENT is the failure: the picker would offer a value
    // the server then silently drops.
    const block = board.slice(
      board.indexOf("export const BUYER_CATEGORY_OPTIONS"),
      board.indexOf("];", board.indexOf("export const BUYER_CATEGORY_OPTIONS")),
    );
    const serverList = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(serverList).toEqual([...BUYER_CATEGORY_OPTIONS]);
  });

  it("rejects are handed back rather than dropped in silence", () => {
    expect(board).toContain("export function partitionCategories");
    const wants = read(EDGE_WANTS);
    expect(wants).toContain("partitionCategories(want.categories)");
    expect(wants).toContain("ignored_categories: ignored");
    // And the client says so out loud.
    expect(read(DEMAND)).toContain("res.ignored_categories?.length");
  });

  it("a want left with no criteria is refused, not stored as a no-op", () => {
    const wants = read(EDGE_WANTS);
    const at = wants.indexOf("partitionCategories(want.categories)");
    const after = wants.slice(at, at + 900);
    expect(after).toContain("hasCriteria(want)");
    expect(after).toMatch(/400/);
  });
});

describe("sizes are per group, not one bucket (US-2552 AC3)", () => {
  it("every garment category belongs to exactly one group", () => {
    // A category in no group is a size question nobody can answer; a category in
    // two is a contradiction about which size applies.
    const seen = new Map<string, string>();
    for (const g of SIZE_GROUPS) {
      for (const c of g.categories) {
        expect(seen.has(c), `${c} is in two groups`).toBe(false);
        seen.set(c, g.key);
      }
    }
    for (const c of BUYER_CATEGORY_OPTIONS) {
      expect(seen.has(c), `${c} belongs to no size group`).toBe(true);
    }
  });

  it("reads and writes the shape the rest of the app already expects", () => {
    // watchlist.ts has iterated sizes as GROUPS since US-1798 — the `{ all: … }`
    // bucket the two buyer pages wrote was the odd one out, and it was being
    // copied straight into saved searches.
    const buckets = readSizeBuckets({ tops: ["M", " L "], shoes: [], bogus: ["x"] });
    expect(buckets).toEqual({ tops: ["M", "L"] });
    expect(writeSizeBuckets({ tops: ["M"], shoes: [] })).toEqual({ tops: ["M"] });
    expect(read("src/lib/watchlist.ts")).toContain(
      "Object.entries(prefs.sizes ?? {})",
    );
  });

  it("an older answer is preserved, not spread and not deleted", () => {
    // Spreading it would claim a shoe size is also a jeans size; dropping it
    // would delete something the buyer told us.
    expect(readLegacySizes({ all: ["M", "32"] })).toEqual(["M", "32"]);
    expect(readSizeBuckets({ all: ["M"] })).toEqual({});
    expect(writeSizeBuckets({ tops: ["L"] }, ["M", "32"])).toEqual({
      tops: ["L"],
      all: ["M", "32"],
    });
  });

  it("neither page writes the single bucket any more", () => {
    for (const rel of [ONBOARDING, SETTINGS]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\{ all: sizes \}/);
      expect(src, rel).toContain("writeSizeBuckets");
      expect(src, rel).toContain("SIZE_GROUPS.map");
    }
    // And the buyer is told what happened to the old answer.
    expect(read(SETTINGS)).toContain("before we asked by type");
  });
});

describe("posting a want leads somewhere (US-2552 AC5)", () => {
  it("the matches are readable, scoped to their owner", () => {
    const wants = read(EDGE_WANTS);
    expect(wants).toContain('buyerWantsRoutes.get("/wants/:id/matches"');
    // US-268: ownership is checked on the want AND the match rows, because
    // want_matches is written by a cron on the service-role client.
    const at = wants.indexOf('buyerWantsRoutes.get("/wants/:id/matches"');
    const handler = wants.slice(at, at + 2200);
    expect(handler).toContain('.eq("user_id", userId)');
    expect(handler).toContain('.eq("buyer_user_id", userId)');
    expect(handler).toContain('return c.json({ error: "Want not found" }, 404)');
  });

  it("reading is not gated on the paid feature", () => {
    // Same rule the list read already follows: a lapsed plan must not hide data
    // the buyer already has.
    const wants = read(EDGE_WANTS);
    const at = wants.indexOf('buyerWantsRoutes.get("/wants/:id/matches"');
    const handler = wants.slice(at, at + 2200);
    expect(handler).not.toContain("requireBuyerFeature");
  });

  it("the page can actually show them", () => {
    const src = read(DEMAND);
    expect(src).toContain("useWantMatches");
    expect(src).toContain("<WantMatches");
    expect(src).toContain("/cert/${m.certificateId}");
    // The toast stops being the end of the story.
    expect(src).toContain("Open the want to see them");
    expect(src).toContain("setOpenMatches(res.want_id)");
  });

  it("the matches list has a real error state, checked before loading", () => {
    const src = read(DEMAND);
    const at = src.indexOf("function WantMatches(");
    const body = src.slice(at);
    const errorAt = body.indexOf("if (isError)");
    const loadingAt = body.indexOf("if (isLoading)");
    expect(errorAt).toBeGreaterThan(-1);
    expect(loadingAt).toBeGreaterThan(-1);
    expect(errorAt).toBeLessThan(loadingAt);
  });
});
