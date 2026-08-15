import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// US-2500: what the public pages say about the eval gate has to match what the
// pipeline enforces.
//
// The claim that was wrong for months read "every new model version must clear a
// fixed eval gate against a golden set of expert-graded garments before it
// grades live items". Two halves of that are enforced and one is not, and the
// sentence gave a reader no way to tell them apart:
//
//   ENFORCED IN CODE. activatePromptVersion() refuses a version whose most
//   recent eval run did not pass, and checkPromptServingEligibility() also
//   refuses one qualified on a different model than the one that will serve.
//   The canary route shares the same gate (US-2300).
//
//   NOT ENFORCED. The prompt shipped in the code (COMPOSITE_PROMPT_VERSION) is
//   the fallback whenever no promoted version is active. It reaches live grading
//   through a deploy, which passes through no gate at all. Nothing in CI runs
//   the golden-set eval either.
//
// So this file pins both directions. If someone deletes the gate, the pages are
// now overclaiming and a test says so. If someone restores the old absolute
// sentence, a test says that too.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const METHODOLOGY = "src/pages/marketing/grading-methodology.tsx";
const TRANSPARENCY = "src/pages/marketing/transparency.tsx";
const GRADING_EVAL = "services/edge-functions/src/lib/grading-eval.ts";
const AI_GRADING = "services/edge-functions/src/lib/ai-grading.ts";

describe("the gate the pages describe still exists", () => {
  const evalSrc = read(GRADING_EVAL);

  it("activation refuses a version whose eval did not pass", () => {
    const fn = evalSrc.match(
      /export function checkPromptServingEligibility[\s\S]*?\n}/,
    )?.[0];
    expect(fn, "checkPromptServingEligibility not found - was it renamed?").toBeTruthy();
    expect(
      fn!,
      "the eval-pass refusal is gone, so /grading/methodology and /transparency " +
        "now claim a gate the code does not apply",
    ).toMatch(/eval_passed\s*!==\s*true/);
  });

  it("activation refuses a pass earned on a different model", () => {
    const fn = evalSrc.match(
      /export function checkPromptServingEligibility[\s\S]*?\n}/,
    )?.[0] ?? "";
    expect(
      fn,
      "the model-qualification check (US-2036) is gone, but both pages say the " +
        "gate is measured on the model that will run it",
    ).toMatch(/qualified_model\s*!==\s*liveModel/);
  });

  it("activatePromptVersion routes through that check rather than its own copy", () => {
    const fn = evalSrc.match(
      /export async function activatePromptVersion[\s\S]*?\n}/,
    )?.[0];
    expect(fn, "activatePromptVersion not found - was it renamed?").toBeTruthy();
    expect(fn!).toContain("checkPromptServingEligibility");
  });
});

describe("the exception the pages now name is still real", () => {
  it("the code-shipped prompt is the fallback when no version is promoted", () => {
    // This is the half no gate covers. If the fallback ever disappears - every
    // grade served from a DB row that passed the gate - the pages should stop
    // carrying the caveat, and this test is where you find out.
    const src = read(AI_GRADING);
    expect(
      src,
      "the code-default composite prompt fallback is gone; the pages still " +
        "explain it as the ungated path, so drop that caveat",
    ).toMatch(/resolveActivePrompt\(\s*\n?\s*"composite"/);
    expect(src).toMatch(/versionName:\s*COMPOSITE_PROMPT_VERSION/);
  });
});

describe("neither page reasserts the absolute claim", () => {
  // The exact shape that was wrong: a universal "must clear ... before it grades
  // live items", with no mention of promotion or of the code-shipped fallback.
  const BANNED = [
    /every new model version must clear/i,
    /cannot grade live items until/i,
    /proven against the golden set before it went\s+live/i,
  ];

  for (const page of [METHODOLOGY, TRANSPARENCY]) {
    it(`${page} states the gate as promotion-scoped`, () => {
      const src = read(page);
      for (const re of BANNED) {
        expect(
          re.test(src),
          `${page} reasserts an unqualified eval-gate claim (${re}). The gate ` +
            "applies to a PROMOTED prompt version; the code-shipped prompt " +
            "reaches live grading through a deploy and clears no gate.",
        ).toBe(false);
      }
    });
  }

  it("the methodology page names the promotion scope and the fallback", () => {
    const src = read(METHODOLOGY);
    expect(src).toMatch(/promoted through our admin flow/);
    expect(src).toMatch(/fallback when no\s+promoted version is active/);
  });

  it("the transparency page names the same two things", () => {
    const src = read(TRANSPARENCY);
    expect(src).toMatch(/cannot be promoted to serve live traffic/);
    expect(src).toMatch(/fallback when no promoted version is active/);
  });
});

describe("no CI lane runs the golden-set eval", () => {
  // The reason the pages may not promise an automatic gate. If a workflow ever
  // does run it, this test fails and the copy can be strengthened deliberately
  // rather than by someone remembering that it changed.
  it("so the copy may not promise one", () => {
    const workflows = [
      ".github/workflows/ci.yml",
      ".github/workflows/db-migrations.yml",
    ];
    for (const wf of workflows) {
      const src = read(wf);
      expect(
        /runEval|grading-eval|golden[- ]set/i.test(src),
        `${wf} appears to run the golden-set eval now. If that is real, the ` +
          "pages may say the gate is automatic - update them and this test together.",
      ).toBe(false);
    }
  });
});
