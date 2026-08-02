// US-2034 — EDGE half of the shared weighted-overall guard.
//
// The web asserts the same fixture (src/lib/__tests__/weighted-grade.test.ts).
// This formula necessarily exists twice — the SPA and the Deno edge are separate
// projects that cannot import across each other — so the mirror is legitimate.
// What is NOT legitimate is pinning it with a comment: "keep in lockstep with
// human-review.computeWeightedOverall" was written on the AI-grading copy, and
// the drift shipped anyway. Twice: US-1557 (admin/grading.tsx) and US-2034
// (admin/disputes.tsx, which rounded to 0.5 while the server stored 0.1).
//
// One table, both suites. That is the mechanism.

import { assertAlmostEquals, assertEquals } from "@std/assert";

// US-2306: ai-grading.ts pulls in supabase.ts, which throws at module load
// without env. Set dummies BEFORE that import (dynamic, below) — same pattern
// as job-lock_test.ts and email-retry_test.ts.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import { computeWeightedOverall } from "../lib/human-review.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/weighted-grade-cases.json",
      import.meta.url,
    ),
  ),
) as {
  cases: Array<{
    factors: Record<string, number>;
    expected_overall: number;
  }>;
};

Deno.test("edge weighted overall matches the cross-project fixture", () => {
  assertEquals(
    fixture.cases.length > 10,
    true,
    "fixture looks truncated — it should carry a broad spread of vectors",
  );
  for (const c of fixture.cases) {
    assertEquals(
      computeWeightedOverall(
        c.factors as unknown as Parameters<typeof computeWeightedOverall>[0],
      ),
      c.expected_overall,
      `factors ${JSON.stringify(c.factors)}`,
    );
  }
});

Deno.test("edge rounds to 0.1, NOT 0.5 — the drift that shipped twice", () => {
  const factors = {
    fabric_condition_score: 8.5,
    structural_integrity_score: 8.5,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.0,
    odor_cleanliness_score: 8.5,
  };
  const got = computeWeightedOverall(
    factors as unknown as Parameters<typeof computeWeightedOverall>[0],
  );
  assertEquals(got, 8.3);
  assertEquals(got === 8.5, false, "0.5-rounding is the bug this pins");
});

Deno.test("edge weights sum to exactly 1.0", () => {
  // An all-equal input returning that same value proves the weights are a true
  // average, i.e. that they sum to 1 — without needing the private table.
  for (const v of [1, 5.5, 7, 10]) {
    const factors = {
      fabric_condition_score: v,
      structural_integrity_score: v,
      cosmetic_appearance_score: v,
      functional_elements_score: v,
      odor_cleanliness_score: v,
    };
    assertAlmostEquals(
      computeWeightedOverall(
        factors as unknown as Parameters<typeof computeWeightedOverall>[0],
      ),
      v,
      1e-9,
    );
  }
});

// ── US-2306: the THIRD copy of the weight table ──────────────────────
//
// ai-grading.ts carries its own FACTOR_WEIGHTS. It was module-private, so
// nothing could pin it, and its lockstep comment said "keep THIS in lockstep"
// — a phrasing the drift-guard's marker regex did not match, so the file was
// absent from the registry too. Correct by inspection, guarded by nothing.
//
// It is NOT a redundant copy that could simply be imported away. human-review's
// table is keyed by the DB COLUMN names (…_score) because that is the shape of
// a stored grade; ai-grading's is keyed by the AI RESPONSE field names. Same
// five numbers, two key spaces. So the fix is to pin them to each other through
// the key map, which is what this does.

const { FACTOR_WEIGHTS: AI_WEIGHTS } = await import("../lib/ai-grading.ts");
const { FACTOR_WEIGHTS: REVIEW_WEIGHTS } = await import(
  "../lib/human-review.ts"
);

/** AI response field → DB column. The only thing that differs between them. */
const KEY_MAP = {
  fabric_condition: "fabric_condition_score",
  structural_integrity: "structural_integrity_score",
  cosmetic_appearance: "cosmetic_appearance_score",
  functional_elements: "functional_elements_score",
  odor_cleanliness: "odor_cleanliness_score",
} as const;

Deno.test("US-2306: ai-grading's weights match human-review's, factor for factor", () => {
  for (const [aiKey, dbKey] of Object.entries(KEY_MAP)) {
    assertEquals(
      AI_WEIGHTS[aiKey as keyof typeof AI_WEIGHTS],
      REVIEW_WEIGHTS[dbKey as keyof typeof REVIEW_WEIGHTS],
      `weight drift on ${aiKey}: the AI composite and the human-review recompute ` +
        "would disagree, so a reviewer's correction would move the overall by a " +
        "different amount than the original grade was built from",
    );
  }
});

Deno.test("US-2306: the key map covers both tables exactly", () => {
  // Without this the test above passes vacuously if a sixth factor is added to
  // one side — the same class of hole as the marker regex that hid this file.
  assertEquals(
    Object.keys(AI_WEIGHTS).sort(),
    Object.keys(KEY_MAP).sort(),
    "ai-grading gained or lost a factor — update the key map",
  );
  assertEquals(
    Object.keys(REVIEW_WEIGHTS).sort(),
    Object.values(KEY_MAP).slice().sort(),
    "human-review gained or lost a factor — update the key map",
  );
});

Deno.test("US-2306: ai-grading's weights sum to exactly 1.0", () => {
  const sum = Object.values(AI_WEIGHTS).reduce((a, b) => a + b, 0);
  assertAlmostEquals(sum, 1, 1e-9);
});

// US-2386 — the refusal half of the shared fixture, edge side.
//
// Before this, the edge returned NaN where the web returned a coalesced 0 for
// the same input: two implementations that must agree byte-for-byte, disagreeing
// on the one case neither suite covered. Both now refuse, and both refuse on
// THIS table, so they cannot drift apart on it again.
//
// The edge half matters more than the web half here. This is the implementation
// the reseal path uses (buildResealFields below), so a wrong number produced
// here is not merely shown to an operator -- it is sealed into the certificate's
// tamper-evident hash and served to buyers as authoritative.
const refusalFixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/weighted-grade-cases.json",
      import.meta.url,
    ),
  ),
) as {
  refusal_cases: Array<{ why: string; factors: Record<string, unknown> }>;
};

// JSON has no NaN literal, so the fixture carries the sentinel "__NaN__".
function hydrateFactors(factors: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(factors)) {
    out[k] = v === "__NaN__" ? Number.NaN : v;
  }
  return out;
}

Deno.test("edge refuses every refusal case in the cross-project fixture", () => {
  assertEquals(
    refusalFixture.refusal_cases.length > 4,
    true,
    "refusal fixture looks truncated",
  );
  for (const c of refusalFixture.refusal_cases) {
    let threw = false;
    try {
      computeWeightedOverall(
        hydrateFactors(c.factors) as unknown as Parameters<
          typeof computeWeightedOverall
        >[0],
      );
    } catch (err) {
      threw = true;
      assertEquals(
        /missing or not finite/.test(
          err instanceof Error ? err.message : String(err),
        ),
        true,
        `refused for the wrong reason: ${c.why}`,
      );
    }
    assertEquals(threw, true, `should refuse: ${c.why}`);
  }
});

Deno.test("edge translates the NaN sentinel rather than asserting on a string", () => {
  // A runner that skipped hydration would still see a throw -- a string factor
  // is refused too -- so the NaN case would pass for the wrong reason.
  const raw = refusalFixture.refusal_cases.find((c) =>
    Object.values(c.factors).includes("__NaN__")
  );
  assertEquals(raw !== undefined, true, "fixture should carry a NaN sentinel");
  const values = Object.values(hydrateFactors(raw!.factors));
  assertEquals(
    values.some((v) => typeof v === "number" && Number.isNaN(v)),
    true,
  );
  assertEquals(values.includes("__NaN__"), false);
});

Deno.test("edge still computes normally when every factor is present", () => {
  // 0 is not a valid factor but IS finite, so it must compute rather than being
  // caught by accident -- the guard refuses INCOMPLETE sets, not low ones.
  const all = (v: number) => ({
    fabric_condition_score: v,
    structural_integrity_score: v,
    cosmetic_appearance_score: v,
    functional_elements_score: v,
    odor_cleanliness_score: v,
  });
  assertEquals(computeWeightedOverall(all(1)), 1);
  assertEquals(computeWeightedOverall(all(10)), 10);
  assertEquals(computeWeightedOverall(all(0)), 0);
});
