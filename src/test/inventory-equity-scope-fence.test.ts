// US-1868: the Inventory Equity scope fence, enforced instead of described.
//
// Phase 1 of GradeThread Capital is DISPLAY-ONLY valuation. Phase 2 — advances
// against inventory — is deferred pending legal counsel and an explicit founder
// green-light. That fence lived in one story's acceptance criteria, which is a
// place no build step reads: the second, third and fourth features on this
// surface can each cross it without one thing going red.
//
// So the two halves that a machine CAN check are checked here, over surfaces
// found by DISCOVERY rather than a hand-written list — because the surface that
// breaks the fence is by definition the one nobody thought to list. US-1871
// (the iOS Money-tab card) does not exist yet and is already covered.
//
// What this cannot check: whether the ESTIMATE is any good. That is
// inventory-equity_test.ts's job. This one only guards what the estimate is
// allowed to claim to be.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  EQUITY_ESTIMATE_DISCLOSURE,
  EQUITY_REFUSAL_CLAUSE,
  PHASE_2_REFUSED_TERMS,
} from "@/lib/inventory-equity-disclosure";

const ROOT = resolve(process.cwd());

// Where an equity surface could live. Each is walked in full; a tree that is
// absent on this checkout (android/ on a web-only clone) is simply skipped.
const SEARCH_ROOTS = [
  "src",
  "services/edge-functions/src",
  "functions",
  "ios",
  "android",
];

const SOURCE_EXTS = new Set([".ts", ".tsx", ".swift", ".kt"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

// This file and the module it imports ARE the fence; they name the refused
// vocabulary on purpose, so scanning them would fail by definition.
const FENCE_FILES = new Set([
  "src/lib/inventory-equity-disclosure.ts",
  "src/test/inventory-equity-scope-fence.test.ts",
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // tree absent on this checkout
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.has(extname(name))) out.push(full);
  }
}

/** Every source file whose PATH says it is an Inventory Equity surface. */
function equityFiles(): string[] {
  const all: string[] = [];
  for (const r of SEARCH_ROOTS) walk(join(ROOT, r), all);
  return all
    .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
    .filter((f) => /equity/i.test(f))
    .filter((f) => !FENCE_FILES.has(f))
    .sort();
}

/**
 * Strip whole-line comments and block comments.
 *
 * The fence is about what the PRODUCT says, not what the source explains about
 * itself: every equity file's header comment states "no lending", and a guard
 * that fires on the sentence declaring the rule is a guard that gets deleted.
 * Only whole-line `//` is removed, so a `//` inside a URL string survives.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** Collapse whitespace so JSX/Swift line wrapping does not defeat a match. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const FILES = equityFiles();

describe("Inventory Equity scope fence (US-1868)", () => {
  it("discovers the equity surfaces that exist today", () => {
    // A zero-length scan would make every assertion below vacuously true, which
    // is the failure mode of a discovery-based guard.
    expect(FILES.length).toBeGreaterThanOrEqual(4);
    expect(FILES).toContain("src/components/flipdesk/inventory-equity-card.tsx");
    expect(FILES).toContain("services/edge-functions/src/lib/inventory-equity.ts");
    expect(FILES).toContain("services/edge-functions/src/routes/flipdesk-equity.ts");
  });

  it("carries no Phase-2 lending vocabulary in product copy", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      // The disclosure REFUSES borrowing capacity by naming it; take the
      // sanctioned sentence out before looking for the words it contains.
      const body = norm(stripComments(readFileSync(join(ROOT, f), "utf8")))
        .split(norm(EQUITY_ESTIMATE_DISCLOSURE))
        .join(" ")
        .split(norm(EQUITY_REFUSAL_CLAUSE))
        .join(" ");
      for (const re of PHASE_2_REFUSED_TERMS) {
        const hit = body.match(re);
        if (hit) offenders.push(`${f}: ${hit[0]}`);
      }
    }
    // Phase 2 (advances / lending against inventory) is DEFERRED pending legal
    // counsel and an explicit founder green-light. If you are here because a
    // legitimate word tripped this, widen the term's regex — do not delete the
    // fence.
    expect(offenders).toEqual([]);
  });

  it("shows the estimate disclosure on every equity display surface", () => {
    // A display surface = a UI file (component/view) named for equity. The edge
    // libs and routes are not display surfaces and are not required to carry it.
    const displays = FILES.filter((f) => /\.(tsx|swift|kt)$/.test(f));
    expect(displays.length).toBeGreaterThan(0);
    for (const f of displays) {
      // Comments and import lines are stripped first: a file that imports the
      // constant, or merely NAMES it in its header comment, while rendering
      // nothing is exactly the shape this is meant to catch — and both read as
      // compliant until a mutation check said otherwise.
      const src = stripComments(readFileSync(join(ROOT, f), "utf8"))
        .replace(/^\s*import\b.*$/gm, " ");
      const carries = src.includes("EQUITY_ESTIMATE_DISCLOSURE") ||
        norm(src).includes(norm(EQUITY_ESTIMATE_DISCLOSURE));
      // Every surface renders the SAME sentence — a per-platform paraphrase is
      // how one of them ends up promising something the others do not.
      expect(carries, `${f} must render EQUITY_ESTIMATE_DISCLOSURE verbatim`).toBe(true);
    }
  });

  it("keeps the disclosure saying estimate, and saying what it is not", () => {
    expect(EQUITY_ESTIMATE_DISCLOSURE).toMatch(/^An estimate\b/);
    expect(EQUITY_ESTIMATE_DISCLOSURE).toContain(EQUITY_REFUSAL_CLAUSE);
  });

  it("spends nothing new: no AI or live comp fetch on the equity path", () => {
    // AC4 — the valuation composes cached comp_set + stored grades only. An
    // Anthropic call or a live eBay Browse fetch here would put the number on a
    // per-view cost, and the nightly snapshot job runs it for every seller.
    const banned = [
      /anthropic/i,
      /callClaude|claudeVision|messages\.create/,
      /browse\/v1\/item_summary/i,
      /fetchSoldComps|refreshComps|searchEbayComps/,
    ];
    const offenders: string[] = [];
    for (const f of FILES.filter((f) => f.startsWith("services/edge-functions/"))) {
      const body = stripComments(readFileSync(join(ROOT, f), "utf8"));
      for (const re of banned) {
        const hit = body.match(re);
        if (hit) offenders.push(`${f}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
