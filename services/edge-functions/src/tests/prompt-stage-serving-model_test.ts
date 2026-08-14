// US-2307: a listing prompt could never be activated, and the reason was a
// write nobody made.
//
// listing-eval wrote eval_passed and eval_run_id and never stamped
// qualified_model. The activation gate FAILS CLOSED on a missing stamp — by
// design, since US-2036: an eval pass we cannot attribute to a model is not a
// pass we can honour. So listing_gen_v2 (seeded by 00446) was permanently
// unpromotable: run the eval, watch it pass, watch eval_passed go true, and
// still be refused with a message about the pass predating model attribution.
// Nothing in that loop points at the missing write.
//
// ── THE PART THE STORY DOES NOT SAY ─────────────────────────────────────────
// Stamping alone would not have been enough. `ai_prompt_versions.stage` is one
// of three and they do not share a model:
//
//   per_image   → getDefaultModel()
//   composite   → getGradingCompositeModel()
//   listing_gen → getDefaultModel()
//
// Both the activation gate and the canary route compared EVERY stage against
// getGradingCompositeModel(). US-2300 made them share one gate function, which
// stopped them drifting from each other — but both callers passed the same
// wrong model, so they agreed and were both wrong for two stages out of three.
// A shared gate fed the wrong input is a consistent answer, not a correct one.
//
// For per_image that is the US-2036 hole reopened one stage over: a prompt
// qualified on the composite model, serving every paid grade on the default
// one, with eval_passed reading true.
//
// ── WHY THIS IS SAFE TO CHANGE ──────────────────────────────────────────────
// getGradingCompositeModel() returns getDefaultModel() unless
// GRADING_COMPOSITE_MODEL is set. With no override all three stages resolve to
// the same string, so this is a literal no-op today. It only diverges once an
// operator deliberately splits the models — which is exactly the moment the old
// code began attributing prompts to a model that never ran them.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { servingModelForStage, getDefaultModel, getGradingCompositeModel } =
  await import("../lib/ai-config.ts");
const { checkPromptServingEligibility } = await import("../lib/grading-eval.ts");

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

/**
 * The lines of a handler up to its first statement that touches the database.
 *
 * Bounded by the WRITE rather than by a character count. The first version of
 * this used `slice(at, at + 400)` and reported the deactivate route as
 * unguarded — its step-up sits about 300 characters in, but the file is CRLF,
 * and the extra byte per line pushed it past the window. A guard that fails on
 * line endings gets read as a real finding once and ignored forever after.
 *
 * Bounding at the first supabaseAdmin/body read also says the thing worth
 * saying: the gate has to come before the work, not merely somewhere in the
 * handler.
 */
function beforeFirstEffect(src: string, at: number): string {
  const rest = src.slice(at);
  const ends = [
    rest.indexOf("supabaseAdmin"),
    rest.indexOf("await c.req.json()"),
    rest.search(/\n\w+Routes\.(get|post|put|patch|delete)\(/),
  ].filter((i) => i > 0);
  return rest.slice(0, ends.length ? Math.min(...ends) : rest.length);
}

Deno.test("US-2307: each stage resolves to the model that actually serves it", () => {
  // Asserted against the helpers rather than literal model ids, so this keeps
  // holding when the default model changes.
  assertEquals(servingModelForStage("per_image"), getDefaultModel());
  assertEquals(servingModelForStage("listing_gen"), getDefaultModel());
  assertEquals(servingModelForStage("composite"), getGradingCompositeModel());
});

Deno.test("US-2307: an unknown stage gets the STRICTEST model, not the laxest", () => {
  // THE OVERRIDE IS SET DELIBERATELY, and without it this case proves nothing.
  //
  // The first version asserted the unknown stage equals getGradingCompositeModel()
  // in the ambient environment — where no GRADING_COMPOSITE_MODEL is set, so
  // that helper just returns getDefaultModel() and BOTH arms are the same
  // string. Negative verification caught it: flipping the default arm to the
  // laxest model left the case green. It was asserting an equality that held
  // for the wrong reason.
  //
  // The two models only differ when an operator splits them, so that is the
  // only configuration in which "strictest" is even a meaningful word.
  const prior = Deno.env.get("GRADING_COMPOSITE_MODEL");
  // On the grading allowlist, and NOT the default — an off-allowlist value
  // would be refused and fall back, collapsing the distinction again.
  Deno.env.set("GRADING_COMPOSITE_MODEL", "claude-opus-4-8");
  try {
    assert(
      getGradingCompositeModel() !== getDefaultModel(),
      "the override did not take effect, so this case cannot tell the two apart",
    );
    // A stage nobody has classified must not get a weaker gate than the ones
    // that were. Fail-closed, the same instinct as refusing a missing stamp.
    assertEquals(servingModelForStage("something_new"), getGradingCompositeModel());
    assertEquals(servingModelForStage(""), getGradingCompositeModel());
    // And the classified stages still resolve to their own models.
    assertEquals(servingModelForStage("listing_gen"), getDefaultModel());
    assertEquals(servingModelForStage("composite"), getGradingCompositeModel());
  } finally {
    if (prior === undefined) Deno.env.delete("GRADING_COMPOSITE_MODEL");
    else Deno.env.set("GRADING_COMPOSITE_MODEL", prior);
  }
});

Deno.test("US-2307: with no override every stage agrees — the change is a no-op", () => {
  // The safety argument, pinned. If this ever fails, the refactor stopped being
  // behaviour-preserving for the default configuration and needs re-reading.
  assert(
    !Deno.env.get("GRADING_COMPOSITE_MODEL"),
    "this case describes the un-overridden configuration",
  );
  const all = ["per_image", "composite", "listing_gen"].map(servingModelForStage);
  assertEquals(new Set(all).size, 1, "stages diverge without an operator override");
});

Deno.test("US-2307 AC2: a stamped listing prompt is now eligible", () => {
  // AC2 asks for a test proving listing_gen_v2 can be activated. Activation
  // itself writes to the database; the DECISION is pure, and it is the decision
  // that refused. Driven through the real gate with the real per-stage model.
  const stage = "listing_gen";
  const model = servingModelForStage(stage);

  // Before the fix: eval passed, nothing stamped.
  const unstamped = checkPromptServingEligibility(
    { eval_passed: true, qualified_model: null },
    model,
  );
  assertEquals(unstamped.ok, false, "a missing stamp must still fail closed");
  assert(
    !unstamped.ok && /model attribution/i.test(unstamped.reason),
    "the refusal no longer explains that the stamp is what is missing",
  );

  // After the fix: the listing eval stamps the model it ran on.
  const stamped = checkPromptServingEligibility(
    { eval_passed: true, qualified_model: model },
    model,
  );
  assertEquals(stamped.ok, true, "listing_gen_v2 is still unpromotable");
});

Deno.test("US-2307: the listing eval stamps, and clears the stamp on failure", () => {
  const src = read("../lib/listing-eval.ts").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert(
    /qualified_model: passed \? model : null/.test(src),
    "listing-eval no longer stamps qualified_model, so every listing prompt is " +
      "unpromotable again",
  );
  // Cleared on failure, like the grading eval. A stale pass from an earlier
  // model must not survive a failing run and be read as attribution it never
  // earned.
  assert(
    !/qualified_model: model\b/.test(src),
    "the stamp is written unconditionally, so a FAILING run leaves attribution " +
      "behind that the run did not earn",
  );
});

Deno.test("US-2307: both serving gates take the stage's own model", () => {
  // Comments stripped: both files now explain this at length and name
  // getGradingCompositeModel in the prose, so a raw scan would find the old
  // shape in the explanation of why it was wrong.
  // US-2505: LINE comments first, then block comments — not the other way round.
  // admin-grading.ts documents its auth group as `// … /api/admin/*`, and the
  // `/*` inside that path is not a comment opener, but a block-first strip reads
  // it as one and deletes everything up to the next `*/`. Whether that swallowed
  // the assertion below depended on where the nearest `*/` happened to sit, so
  // adding an unrelated JSDoc block elsewhere in the file could turn this test
  // red while the code it checks was untouched. Stripping line comments first
  // removes the false opener before the block pass ever sees it. Verified: the
  // fixed order still fails when the gate really does regress to
  // getGradingCompositeModel().
  const strip = (s: string) =>
    s.replace(/(^|\s)\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const evalLib = strip(read("../lib/grading-eval.ts"));
  const admin = strip(read("../routes/admin-grading.ts"));

  for (const [name, src] of [["activate", evalLib], ["canary", admin]] as const) {
    assert(
      /checkPromptServingEligibility\(v, servingModelForStage\(v\.stage\)\)/.test(src),
      `the ${name} gate compares against a single model for every stage again — ` +
        "sharing the gate function does not help when both callers feed it the " +
        "wrong input",
    );
  }
  // And the eval must RUN on the same model it stamps, or the gate it feeds can
  // never match for a stage whose serving model differs.
  assert(
    /: servingModelForStage\(v\.stage\);/.test(evalLib),
    "the eval no longer runs on the stage's serving model, so the stamp it " +
      "writes describes a model the prompt was not measured on",
  );
});

Deno.test("US-2307 AC4: what reaches the golden set is gated; what cannot, is not", () => {
  // AC4 asks whether the step-up asymmetry was deliberate. It was not — but the
  // answer is NOT "gate every writer", and finding that out is the substance of
  // this AC.
  //
  // The line is whether the write can reach the EVAL GATE, because the golden
  // set is what promotes a prompt to live paid traffic. Whoever controls the
  // active cases controls that gate.
  //
  //   POST /eval/cases      GATED. `is_active` DEFAULTS TO TRUE (00050), so a
  //                         case built from a request body counts immediately.
  //                         Adding a fabricated lenient case is the direct way
  //                         to pass a failing prompt, and it edits nothing that
  //                         already exists — the quiet path, and the one that
  //                         had no gate.
  //   PATCH /eval/cases/:id GATED already. This is the approval that flips a
  //                         candidate active — the privileged act.
  //   DELETE                GATED already. Shrinking the set to make an eval
  //                         pass is the failure the contract names outright.
  //
  //   promote, promote-batch  NOT gated, deliberately. Both write
  //                         is_active=false candidates, and the eval loads
  //                         `.eq("is_active", true)` — so nothing they create
  //                         can influence anything until a gated PATCH approves
  //                         it. Gating them would add a second lock to a door
  //                         that is already locked further down the corridor.
  //
  // And gating them would have caused real harm, which is why this is asserted
  // in BOTH directions rather than left as a comment. /promote is called
  // automatically and best-effort after a reviewer adjusts a grade
  // (src/lib/eval-candidates.ts) inside a catch that swallows everything — a
  // 403 there prompts nobody and silently stops the self-improvement loop.
  // /promote-batch is a button whose handler has no step-up replay path, so
  // gating it turns "Grow from corrections" into an error toast.
  const admin = read("../routes/admin-grading.ts");

  const MUST_GATE: Array<[string, string, string]> = [
    ["post", "/eval/cases", "is_active defaults to true — this case counts at once"],
    ["patch", "/eval/cases/:id", "this is the approval that makes a candidate count"],
    ["delete", "/eval/cases/:id", "shrinking the set to pass an eval"],
  ];
  const MUST_NOT_GATE: Array<[string, string, string]> = [
    [
      "post",
      "/eval/cases/promote",
      "creates an inactive candidate, and is called best-effort from a catch " +
        "that would swallow the 403",
    ],
    [
      "post",
      "/eval/cases/promote-batch",
      "creates inactive candidates; its button has no step-up replay path",
    ],
  ];

  const gated = (method: string, path: string) => {
    const at = admin.indexOf(`adminGradingRoutes.${method}("${path}"`);
    assert(at > -1, `${method.toUpperCase()} ${path} is gone or was renamed`);
    // The guard has to be the FIRST thing, before the body is read or any row
    // is touched — so the window ends at whichever comes first.
    return /require(Fresh)?StepUp\(c\)/.test(beforeFirstEffect(admin, at));
  };

  const missing = MUST_GATE.filter(([m, p]) => !gated(m, p))
    .map(([m, p, why]) => `${m.toUpperCase()} ${p} (${why})`);
  assertEquals(
    missing,
    [],
    "these writers reach the eval gate and take no step-up — the gate is only " +
      "as trustworthy as the set it measures against",
  );

  // The other direction, and it is not symmetry for its own sake: a step-up on
  // either of these is a silent outage, not a stricter system.
  const overGated = MUST_NOT_GATE.filter(([m, p]) => gated(m, p))
    .map(([m, p, why]) => `${m.toUpperCase()} ${p} (${why})`);
  assertEquals(
    overGated,
    [],
    "a step-up was added to a route that only creates INACTIVE candidates. " +
      "That blocks nothing an approval does not already block, and breaks the " +
      "caller.",
  );
});

Deno.test("US-2307 AC3: deactivate is gated, matching activate and canary", () => {
  // Already true when this story was picked up — US-2353 fixed it. Pinned here
  // anyway rather than marked done and forgotten: the story named it, and an
  // AC that was satisfied by another story is exactly the kind of thing that
  // quietly regresses because nobody owns it.
  const admin = read("../routes/admin-grading.ts");
  for (const path of ["/prompts/:id/activate", "/prompts/:id/deactivate"]) {
    const at = admin.indexOf(`adminGradingRoutes.post("${path}"`);
    assert(at > -1, `${path} is gone or was renamed`);
    assert(
      /require(Fresh)?StepUp\(c\)/.test(beforeFirstEffect(admin, at)),
      `${path} no longer requires step-up — turning the active prompt off ` +
        "reverts every grade to the code default, which is 'changes live " +
        "grading' reached from the other direction",
    );
  }
});
