// US-3044: the two copies of the aspect demand-rank must agree.
//
// services/edge-functions/src/lib/aspect-priority.ts decides which of a leaf
// category's item-specifics reach the AI tool schema, and therefore which ones
// a draft can possibly fill. scripts/aspect-demand-cut.mjs re-runs that same
// ranking over a captured census of every apparel leaf, to answer whether an
// aspect the coverage metric counts (Theme, in the story that prompted this)
// was ever in the schema at all.
//
// The script cannot import the edge module: it is a node script and that is
// Deno TypeScript. So it is a mirror, and a mirror with nothing enforcing it
// drifts. If these two disagree, the script reports reachability for a ranking
// production does not use, and the answer looks exactly as trustworthy as a
// correct one.
//
// Both sides are loaded through import.meta.glob rather than plain imports, for
// the reason spelled out in admin-review-accuracy-mirror.test.ts: a static
// import of the edge file drags services/edge-functions/ into the WEB tsconfig
// program, where `noUncheckedIndexedAccess` is on and Deno's is not, and a
// static import of the .mjs gives `tsc -b` an untyped module to complain about.
// The glob is resolved by Vite at runtime and typed as `unknown`, so the
// coupling stays behavioural.
import { beforeAll, describe, expect, it } from "vitest";

interface RankableSpec {
  name: string;
  required: boolean;
}
type Ranker = (specs: RankableSpec[], raw: unknown, cap?: number) => RankableSpec[];

interface EdgeModule {
  MAX_AI_ASPECTS: number;
  prioritizeByDemand: Ranker;
}
interface ScriptModule {
  DEFAULT_CAP: number;
  prioritizeByDemand: Ranker;
  specsFromRaw: (raw: unknown) => RankableSpec[];
  reachabilityReport: (
    capture: unknown,
    opts?: { cap?: number; aspects?: string[] },
  ) => { cap: number; leafCount: number; rows: Array<{ name: string; recommended: number }> };
}

let edge: EdgeModule;
let script: ScriptModule;

async function loadOne<T>(pattern: Record<string, () => Promise<unknown>>, suffix: string): Promise<T> {
  const load = Object.entries(pattern).find(([k]) => k.endsWith(suffix))?.[1];
  // A missing module must FAIL, not silently skip: a parity test that quietly
  // stops loading one side is indistinguishable from a passing one.
  expect(load, `module not found for ${suffix}`).toBeTruthy();
  return (await load!()) as T;
}

beforeAll(async () => {
  edge = await loadOne<EdgeModule>(
    import.meta.glob("../../services/edge-functions/src/lib/aspect-priority.ts"),
    "aspect-priority.ts",
  );
  script = await loadOne<ScriptModule>(
    import.meta.glob("../../scripts/aspect-demand-cut.mjs"),
    "aspect-demand-cut.mjs",
  );
  expect(typeof edge.prioritizeByDemand, "edge module has no prioritizeByDemand").toBe("function");
  expect(typeof script.prioritizeByDemand, "script has no prioritizeByDemand").toBe("function");
});

/** A tiny deterministic PRNG, so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const USAGES = ["REQUIRED", "RECOMMENDED", "OPTIONAL"];

function randomLeaf(rand: () => number, size: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < size; i++) {
    const usage = USAGES[Math.floor(rand() * USAGES.length)]!;
    // Three flavours of search signal on purpose: a real number, an absent
    // relevanceIndicator, and a garbage one. The absent case is what eBay
    // actually sends on US apparel, and a NaN comparator silently leaves an
    // array in input order rather than throwing.
    const roll = rand();
    const relevance =
      roll < 0.34
        ? { relevanceIndicator: { searchCount: Math.floor(rand() * 5000) } }
        : roll < 0.67
          ? {}
          : { relevanceIndicator: { searchCount: "not a number" } };
    out.push({
      // Deliberate name collisions (i % 7) so the localeCompare tie-break and
      // the original-index tie-break both get exercised.
      localizedAspectName: `Aspect ${i % 7}${i}`,
      aspectConstraint: { aspectRequired: usage === "REQUIRED", aspectUsage: usage },
      ...relevance,
    });
  }
  return out;
}

describe("aspect-demand-cut.mjs mirrors prioritizeByDemand", () => {
  it("agrees on the cap", () => {
    expect(script.DEFAULT_CAP).toBe(edge.MAX_AI_ASPECTS);
  });

  it("produces the identical ordering over 300 randomized leaves", () => {
    const rand = rng(20260911);
    for (let trial = 0; trial < 300; trial++) {
      const size = 1 + Math.floor(rand() * 70);
      const raw = randomLeaf(rand, size);
      const specs = script.specsFromRaw(raw);
      const cap = 1 + Math.floor(rand() * 60);
      const mine = script.prioritizeByDemand(specs, raw, cap).map((s) => s.name);
      const theirs = edge.prioritizeByDemand(specs, raw, cap).map((s) => s.name);
      expect(mine, `trial ${trial} (size ${size}, cap ${cap})`).toEqual(theirs);
    }
  });

  it("agrees when eBay sends no relevanceIndicator at all, which is the real US apparel case", () => {
    const raw = ["Zeta", "Alpha", "Beta", "Gamma"].map((n, i) => ({
      localizedAspectName: n,
      aspectConstraint: { aspectRequired: false, aspectUsage: i % 2 === 0 ? "RECOMMENDED" : "OPTIONAL" },
    }));
    const specs = script.specsFromRaw(raw);
    const theirs = edge.prioritizeByDemand(specs, raw, 3).map((s) => s.name);
    expect(script.prioritizeByDemand(specs, raw, 3).map((s) => s.name)).toEqual(theirs);
    // With every searchCount absent the demand sort degenerates to
    // RECOMMENDED-before-OPTIONAL then alphabetical. Pinned here because the
    // whole reachability finding rests on it.
    expect(theirs).toEqual(["Beta", "Zeta", "Alpha"]);
  });

  it("never cuts a required aspect, on either side", () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({
      localizedAspectName: `Req ${i}`,
      aspectConstraint: { aspectRequired: true, aspectUsage: "REQUIRED" },
    }));
    const specs = script.specsFromRaw(raw);
    expect(script.prioritizeByDemand(specs, raw, 4)).toHaveLength(12);
    expect(edge.prioritizeByDemand(specs, raw, 4)).toHaveLength(12);
  });
});
