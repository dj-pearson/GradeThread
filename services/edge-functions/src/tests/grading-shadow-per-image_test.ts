// US-2443: per-image shadow grading — pure math plus the whole orchestrator.
//
// The orchestrator is covered here rather than "via the pipeline" (which is how
// the composite shadow's orchestrator is covered) because the thing AC2 promises
// is a NEGATIVE: a shadow run can never affect the seller's grade. A negative is
// only provable by driving the failure branches, and every one of them —
// candidate lookup threw, the challenger threw, the insert threw — is a branch
// no happy-path integration test will ever reach. PerImageShadowDeps exists for
// exactly that, so the cases below run with no database and no vision call.
//
// grading-shadow-per-image.ts transitively imports the service-role supabase
// client, which throws at module init without env — set dummy creds BEFORE the
// dynamic import (mirrors grading-shadow_test.ts).
import { assert, assertEquals } from "@std/assert";
// Type-only, so it is erased before runtime and does NOT trigger module init.
import type {
  PerImageShadowCandidate,
  PerImageShadowContext,
  PerImageShadowDeps,
} from "../lib/grading-shadow-per-image.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  FACTOR_KEYS,
  blockCandidateLabel,
  dailyVisionCap,
  perFactorDeltas,
  projectedVisionCalls,
  runPerImageShadowGrades,
  tiersAgree,
} = await import("../lib/grading-shadow-per-image.ts");

// prompt-blocks.ts transitively imports the service-role client too, so it
// goes through the same dynamic import, after the dummy env above.
const { PROMPT_BLOCK_KEYS } = await import("../lib/prompt-blocks.ts");

type Cand = PerImageShadowCandidate;
type Deps = PerImageShadowDeps;
type Ctx = PerImageShadowContext;

// ── Fixtures ────────────────────────────────────────────────────────

const SCORES = {
  fabric_condition: 8,
  structural_integrity: 8,
  cosmetic_appearance: 7.5,
  functional_elements: 8,
  odor_cleanliness: 9,
};

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    submissionId: "sub-1",
    userId: "user-1",
    gradeReportId: "rep-1",
    images: [
      { imageType: "front", storagePath: "user-1/sub-1/front_1.jpg" },
      { imageType: "back", storagePath: "user-1/sub-1/back_1.jpg" },
    ],
    garmentInfo: {
      garment_type: "tee",
      garment_category: "tops",
      brand: null,
      title: "t",
      description: null,
    },
    styleHint: [],
    activePromptVersion: "champion-v1",
    activeOverallScore: 8.0,
    activeGradeTier: "Excellent",
    activeFactorScores: { ...SCORES },
    // Deterministic: 0 is always below any positive sample rate, so "was it
    // sampled" never depends on the machine's RNG.
    rng: () => 0,
    ...over,
  } as Ctx;
}

function candidate(over: Partial<Cand> = {}): Cand {
  return {
    kind: "prompt",
    id: "cand-1",
    label: "challenger-v2",
    promptText: "grade harder",
    garmentScope: null,
    sampleRate: 1,
    dailyCap: 50,
    ...over,
  } as Cand;
}

/** Deps that succeed, plus the recorded rows and a call tally. */
function deps(over: Partial<Deps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const calls = { fetch: 0, analyze: 0, composite: 0 };
  const base: Deps = {
    loadCandidates: () => Promise.resolve([candidate()]),
    countTodayVisionCalls: () => Promise.resolve(0),
    countTodayRows: () => Promise.resolve(0),
    fetchImage: (p: string) => {
      calls.fetch++;
      return Promise.resolve(`data:image/jpeg;base64,${p}`);
    },
    analyze: () => {
      calls.analyze++;
      return Promise.resolve({} as never);
    },
    composite: () => {
      calls.composite++;
      return Promise.resolve({
        overall_score: 7.5,
        grade_tier: "Very Good",
        factor_scores: { ...SCORES, fabric_condition: 7 },
        model: "claude-test",
      } as never);
    },
    insert: (row: Record<string, unknown>) => {
      rows.push(row);
      return Promise.resolve();
    },
    visionCap: () => 1000,
    ...over,
  } as Deps;
  return { d: base, rows, calls };
}

// ── Pure helpers ────────────────────────────────────────────────────

Deno.test("perFactorDeltas: signed, per factor, rounded to 0.1", () => {
  const out = perFactorDeltas(
    { ...SCORES },
    { ...SCORES, fabric_condition: 7, odor_cleanliness: 9.5 },
  );
  assertEquals(out.fabric_condition, -1);
  assertEquals(out.odor_cleanliness, 0.5);
  // Unchanged factors are still reported as 0 — "absent" and "did not move" are
  // different findings and a reader must not have to guess which one a gap means.
  assertEquals(out.structural_integrity, 0);
  assertEquals(Object.keys(out).length, FACTOR_KEYS.length);
});

Deno.test("perFactorDeltas: a non-numeric factor is dropped, not coerced to 0", () => {
  const out = perFactorDeltas(
    { ...SCORES },
    { ...SCORES, odor_cleanliness: null as unknown as number },
  );
  // A null would round to -9 and read as a catastrophic regression.
  assert(!("odor_cleanliness" in out));
  assertEquals(out.fabric_condition, 0);
});

Deno.test("tiersAgree: null when either tier is missing", () => {
  assertEquals(tiersAgree("Excellent", "Excellent"), true);
  assertEquals(tiersAgree("Excellent", "Very Good"), false);
  // Not `false` — a failed challenger has no tier, and calling that a
  // disagreement would count every error as evidence against the candidate.
  assertEquals(tiersAgree("Excellent", null), null);
  assertEquals(tiersAgree(null, "Excellent"), null);
});

Deno.test("projectedVisionCalls: images + 1, and a rate above 1 clamps", () => {
  // The header's worked example: 400/day, 6 photos, one candidate at 3%.
  assertEquals(
    projectedVisionCalls({
      submissionsPerDay: 400,
      imagesPerSubmission: 6,
      sampleRate: 0.03,
      candidates: 1,
    }),
    84,
  );
  assertEquals(
    projectedVisionCalls({
      submissionsPerDay: 400,
      imagesPerSubmission: 6,
      sampleRate: 0.1,
      candidates: 2,
    }),
    560,
  );
  assertEquals(
    projectedVisionCalls({
      submissionsPerDay: 10,
      imagesPerSubmission: 1,
      sampleRate: 5,
      candidates: 1,
    }),
    20,
  );
  assertEquals(
    projectedVisionCalls({
      submissionsPerDay: Number.NaN,
      imagesPerSubmission: 6,
      sampleRate: 0.1,
      candidates: 1,
    }),
    0,
  );
});

Deno.test("blockCandidateLabel: US-2438's label, with * for an unscoped block", () => {
  assertEquals(
    blockCandidateLabel("garment_type_criteria", "jacket", "v3"),
    "block:garment_type_criteria[jacket]=v3",
  );
  assertEquals(blockCandidateLabel("category_criteria", null, "v1"), "block:category_criteria[*]=v1");
});

Deno.test("dailyVisionCap: unset, junk and negative all read as OFF", () => {
  const prev = Deno.env.get("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
  try {
    Deno.env.delete("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
    assertEquals(dailyVisionCap(), 0);
    Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", "not-a-number");
    assertEquals(dailyVisionCap(), 0);
    Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", "-5");
    assertEquals(dailyVisionCap(), 0);
    Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", "120.9");
    assertEquals(dailyVisionCap(), 120);
  } finally {
    if (prev === undefined) Deno.env.delete("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
    else Deno.env.set("PER_IMAGE_SHADOW_DAILY_VISION_CAP", prev);
  }
});

// ── Orchestrator: the happy path ────────────────────────────────────

Deno.test("runPerImageShadowGrades: re-analyzes EVERY image and records the comparison", async () => {
  const { d, rows, calls } = deps();
  await runPerImageShadowGrades(ctx(), d);

  // Decision 2 in the header: a subset would build a composite from a mix of
  // champion and challenger analyses, so both photos must be re-run.
  assertEquals(calls.fetch, 2);
  assertEquals(calls.analyze, 2);
  assertEquals(calls.composite, 1);

  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.stage, "per_image");
  assertEquals(r.shadow_prompt_version_id, "cand-1");
  assertEquals(r.shadow_block_version_id, null);
  assertEquals(r.shadow_prompt_version_name, "challenger-v2");
  assertEquals(r.score_delta, -0.5);
  assertEquals(r.tier_agreement, false);
  assertEquals(r.images_analyzed, 2);
  assertEquals(r.vision_calls, 3); // 2 photos + 1 composite
  assertEquals((r.per_factor_deltas as Record<string, number>).fabric_condition, -1);
  assertEquals(r.error, null);
});

Deno.test("runPerImageShadowGrades: a block candidate lands in the block column", async () => {
  const { d, rows } = deps({
    loadCandidates: () =>
      Promise.resolve([
        candidate({
          kind: "block",
          id: "blk-9",
          label: "block:category_criteria[*]=v2",
          promptText: "",
          blockKey: "category_criteria",
          blockText: "look closer",
        }),
      ]),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows[0].shadow_block_version_id, "blk-9");
  assertEquals(rows[0].shadow_prompt_version_id, null);
});

// ── Orchestrator: the guardrails ────────────────────────────────────

Deno.test("runPerImageShadowGrades: cap of 0 spends nothing at all", async () => {
  const { d, rows, calls } = deps({ visionCap: () => 0 });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 0);
  assertEquals(calls.fetch, 0);
});

Deno.test("runPerImageShadowGrades: the daily VISION ceiling stops the run", async () => {
  // 998 spent, cap 1000, and this run costs 3 — it must not squeak through.
  const { d, rows } = deps({
    visionCap: () => 1000,
    countTodayVisionCalls: () => Promise.resolve(998),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 0);
});

Deno.test("runPerImageShadowGrades: an unreadable spend count fails CLOSED", async () => {
  // liveDeps returns MAX_SAFE_INTEGER when the count query errors. Nothing is
  // spent, which is the correct direction for a cost guardrail.
  const { d, rows } = deps({
    countTodayVisionCalls: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 0);
});

Deno.test("runPerImageShadowGrades: the per-candidate daily cap skips just that candidate", async () => {
  const { d, rows } = deps({
    loadCandidates: () =>
      Promise.resolve([
        candidate({ id: "full", label: "full", dailyCap: 10 }),
        candidate({ id: "room", label: "room", dailyCap: 10 }),
      ]),
    countTodayRows: (label: string) => Promise.resolve(label === "full" ? 10 : 0),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].shadow_prompt_version_id, "room");
});

Deno.test("runPerImageShadowGrades: a dailyCap of 0 is off, whatever the sample rate says", async () => {
  const { d, rows } = deps({
    loadCandidates: () => Promise.resolve([candidate({ dailyCap: 0, sampleRate: 1 })]),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 0);
});

Deno.test("runPerImageShadowGrades: an unsampled candidate costs nothing", async () => {
  const { d, rows, calls } = deps({
    loadCandidates: () => Promise.resolve([candidate({ sampleRate: 0.01 })]),
  });
  // rng returns 0.9, above the 1% rate.
  await runPerImageShadowGrades(ctx({ rng: () => 0.9 }), d);
  assertEquals(rows.length, 0);
  assertEquals(calls.fetch, 0);
});

Deno.test("runPerImageShadowGrades: a submission with no images is skipped", async () => {
  const { d, rows, calls } = deps();
  await runPerImageShadowGrades(ctx({ images: [] }), d);
  assertEquals(rows.length, 0);
  assertEquals(calls.composite, 0);
});

// ── Orchestrator: AC2, it can never surface into the pipeline ───────

Deno.test("runPerImageShadowGrades: a challenger that threw is RECORDED, not swallowed", async () => {
  const { d, rows } = deps({
    analyze: () => Promise.reject(new Error("vision 529")),
  });
  await runPerImageShadowGrades(ctx(), d); // resolves — does not throw
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.error, "vision 529");
  assertEquals(r.shadow_overall_score, null);
  assertEquals(r.score_delta, null);
  assertEquals(r.agreement, null);
  assertEquals(r.tier_agreement, null);
  assertEquals(r.per_factor_deltas, null);
  // Charged anyway: the calls that went out were paid for, and a ceiling that
  // only counts successes is one a failing candidate walks straight through.
  assertEquals(r.vision_calls, 3);
  assertEquals(r.model, "(error)");
});

Deno.test("runPerImageShadowGrades: a failed image download does not throw either", async () => {
  const { d, rows } = deps({
    fetchImage: () => Promise.reject(new Error("download failed: no body")),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].error, "download failed: no body");
  assertEquals(rows[0].images_analyzed, 0);
});

Deno.test("runPerImageShadowGrades: a failed INSERT is swallowed", async () => {
  const { d } = deps({ insert: () => Promise.reject(new Error("23514 check violation")) });
  await runPerImageShadowGrades(ctx(), d); // the assertion is that this resolves
});

Deno.test("runPerImageShadowGrades: a candidate lookup that threw ends the run quietly", async () => {
  const { d, rows, calls } = deps({
    loadCandidates: () => Promise.reject(new Error("relation does not exist")),
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 0);
  assertEquals(calls.fetch, 0);
});

Deno.test("runPerImageShadowGrades: even a dep that throws SYNCHRONOUSLY cannot escape", async () => {
  // The outer net. A synchronous throw skips every inner try/catch that awaits.
  const { d } = deps({
    visionCap: () => {
      throw new Error("boom");
    },
  });
  await runPerImageShadowGrades(ctx(), d);
});

Deno.test("runPerImageShadowGrades: the second candidate still runs after the first fails", async () => {
  let n = 0;
  const { d, rows } = deps({
    loadCandidates: () =>
      Promise.resolve([
        candidate({ id: "a", label: "a" }),
        candidate({ id: "b", label: "b" }),
      ]),
    composite: () => {
      n++;
      return n === 1
        ? Promise.reject(new Error("first one died"))
        : Promise.resolve({
          overall_score: 8,
          grade_tier: "Excellent",
          factor_scores: { ...SCORES },
          model: "claude-test",
        } as never);
    },
  });
  await runPerImageShadowGrades(ctx(), d);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].error, "first one died");
  assertEquals(rows[1].error, null);
  assertEquals(rows[1].agreement, true);
});

// ── US-2810 AC4: shadow changes no published grade ─────────────────────
//
// The module's own header says 'nothing here reads or writes grade_reports'
// and until now that was a COMMENT. It is the whole safety argument for
// running a candidate on live traffic before any eval gate has cases for it:
// the seller's grade is already written and delivered by the time this runs.
//
// A source scan is the right shape here because the property is about WIRING
// - which tables this module touches - not about logic. The deps seam takes
// an `insert(row)` that names no table, so a behavioural fake cannot see the
// table name at all; liveDeps is where it lives, and that is source.

const SHADOW_SRC = Deno.readTextFileSync(
  new URL("../lib/grading-shadow-per-image.ts", import.meta.url),
);

/** Every `.from("table")` in the module, in order. */
function tablesTouched(src: string): string[] {
  // Comments stripped first: a table named in prose is not an access, and
  // this file's header names grade_reports precisely to say it does NOT use
  // it. Scanning raw text would fail on the sentence promising the property.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
  return [...code.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
}

Deno.test("US-2810 AC4: the shadow path touches no table but its own three", () => {
  // ai_prompt_versions and ai_prompt_block_versions are READ to find the
  // candidate; grading_shadow_results is the only thing written. Anything
  // else appearing here means shadow grew a side effect, and the one that
  // matters is a published grade moving under a seller who was never told a
  // candidate was running.
  const allowed = new Set([
    "ai_prompt_versions",
    "ai_prompt_block_versions",
    "grading_shadow_results",
  ]);
  const touched = new Set(tablesTouched(SHADOW_SRC));
  assert(touched.size > 0, "no table access found at all - the scan is broken");
  for (const t of touched) {
    assert(allowed.has(t), `shadow now touches ${t}, which AC4 forbids`);
  }
});

Deno.test("US-2810 AC4: grade_reports and submissions are not named in code", () => {
  // Named explicitly rather than left to the allow-list above, because these
  // two are the ones the safety argument is ABOUT, and because the allow-list
  // only sees `.from(`: an RPC name or a raw SQL string would slip past it.
  //
  // MATCHED AS A QUOTED LITERAL, which the first version was not. A bare
  // substring check failed on `submissionsPerDay`, a local variable in the
  // cost projection - a guard that fires on an identifier teaches the next
  // reader to widen it rather than to look.
  const code = SHADOW_SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
  for (const table of ["grade_reports", "submissions"]) {
    const quoted = JSON.stringify(table);
    assert(
      !code.includes(quoted),
      `shadow names ${table} as a string literal, which AC4 forbids`,
    );
  }
});

Deno.test("US-2810 AC4: the only write verb is on grading_shadow_results", () => {
  const code = SHADOW_SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
  // Each write verb must be preceded by a .from() naming the results table.
  // Matching the verb ALONE would pass on a write to anything, which is the
  // failure this whole case exists to rule out.
  const writes = [...code.matchAll(/\.(insert|update|upsert|delete)\(/g)];
  assert(writes.length > 0, "no write found - the scan is broken");
  for (const w of writes) {
    const before = code.slice(0, w.index ?? 0);
    const lastFrom = before.lastIndexOf(".from(");
    const table = before.slice(lastFrom).match(/\.from\("([^"]+)"\)/)?.[1];
    assertEquals(
      table,
      "grading_shadow_results",
      `a ${w[1]} runs against ${table}, not the shadow results table`,
    );
  }
});

Deno.test("US-2810 AC2: category_criteria is a real block key, not a typo", () => {
  // A block_key the code does not know is INERT, never an error - so an
  // operator row carrying a typo silently does nothing and reads exactly like
  // a sampling window that found no traffic. The operator SQL copies this
  // string; this pins that it still exists.
  assert(
    Object.keys(PROMPT_BLOCK_KEYS).includes("category_criteria"),
    "category_criteria left PROMPT_BLOCK_KEYS - the operator rows are now inert",
  );
  assertEquals(
    PROMPT_BLOCK_KEYS.category_criteria.stage,
    "per_image",
  );
  assertEquals(
    PROMPT_BLOCK_KEYS.category_criteria.scopeDimension,
    "garment_category",
  );
});

