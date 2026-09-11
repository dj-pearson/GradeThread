// US-3366: the second opinion must read the SAME evidence as the grade it is
// checking.
//
// THE DEFECT THIS FILE EXISTS FOR. grading-pipeline.ts called compositeGrade
// with FIVE arguments for the second opinion where the primary passed all
// twelve, so `baselineBlock`, `verificationImages`, `tagBlock` and
// `referenceAnchors` all fell back to their argument-list defaults. The second
// opinion was not a second read of the same evidence; it was a read of LESS
// evidence by a different model, and a disagreement could then be the missing
// baseline rather than the model, the opposite of what the check measures.
//
// A SOURCE SCAN CANNOT SEE AN ARGUMENT THAT WAS NEVER WRITTEN, which is exactly
// what was wrong. So sections 1 and 2 DRIVE the real call: `messages.create` is
// stubbed and the assertions read the body the SDK was actually handed, the same
// technique grading-cache-premium_test.ts uses and for the same reason.
//
// Section 3 holds the two drift guards (AC4) and they ARE scans, which is the
// right tool for "is this wired the same way as that" (mode 0 of
// guards-that-do-not-guard). Both derive the parameter NAMES from
// compositeGrade's and secondOpinionComposite's own signatures and pair the call
// sites up by position, so neither can be satisfied by a stale hand-written list
// of argument names. The first covers the callee, the second the caller; the gap
// between them was found by sabotage, not by reasoning.
//
//   deno test --allow-all src/tests/composite-evidence_test.ts

import "./_env.ts";

// getAnthropicClient() throws with no key and memoizes on first call, so this
// has to run before any import that might construct it. Deliberately not
// key-shaped: a realistic fixture trips gitleaks on entropy alone.
if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import {
  applyGradingConfidencePolicy,
  compositeGrade,
  type GarmentInfo,
  type PerImageAnalysis,
  type VerificationImage,
} from "../lib/ai-grading.ts";
import { type ReferenceAnchor } from "../lib/reference-anchors.ts";
import { secondOpinionComposite } from "../lib/grading-pipeline.ts";
import {
  DEFAULT_SECOND_OPINION_CONFIG,
  shouldSeekSecondOpinion,
} from "../lib/second-opinion.ts";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const COMPOSITE_JSON = JSON.stringify({
  overall_score: 8,
  grade_tier: "Excellent",
  factor_scores: {
    fabric_condition: 8,
    structural_integrity: 8,
    cosmetic_appearance: 8,
    functional_elements: 8,
    odor_cleanliness: 8,
  },
  ai_summary: "ok",
  buyer_writeup: "ok",
  defects_found: [],
  style_attributes: [],
  confidence_score: 0.9,
  image_validity: { is_clothing: true, reason: "" },
});

const GARMENT: GarmentInfo = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: "Carhartt",
  title: "hoodie",
  description: null,
};

// Sentinels, not realistic prose: the question is whether the STRING the
// pipeline holds reaches the request, and a sentinel answers that unambiguously.
const BASELINE_SENTINEL = "BASELINE-BLOCK-SENTINEL-3366";
const TAG_SENTINEL = "TAG-BLOCK-SENTINEL-3366";

/** The four trusted, server-built blocks the primary composite reads. */
const EVIDENCE: {
  baselineBlock: string;
  verificationImages: VerificationImage[];
  tagBlock: string;
  referenceAnchors: ReferenceAnchor[];
} = {
  baselineBlock: `TRUSTED BASELINE:\n${BASELINE_SENTINEL}`,
  verificationImages: [
    { imageType: "front", dataUri: TINY_PNG },
    { imageType: "detail_fabric", dataUri: TINY_PNG },
  ] as VerificationImage[],
  tagBlock: `TRUSTED LABEL:\n${TAG_SENTINEL}`,
  referenceAnchors: [
    {
      dataUri: TINY_PNG,
      awardedScore: 8,
      factor: null,
      garmentCategory: "hoodie",
    },
  ] as ReferenceAnchor[],
};

const PER_IMAGE: PerImageAnalysis[] = [];

const SECOND_MODEL = "claude-opus-4-8";
const PRIMARY_MODEL = "claude-sonnet-5";
const BUCKET = "00000000-0000-4000-8000-000000003366";

type Body = Record<string, unknown>;
type Block = Record<string, unknown>;

/**
 * Run one real grading call against a stubbed SDK and return the request body.
 *
 * The stub captures first and answers second; anything the post-parse path
 * throws is swallowed, because the subject is what was SENT.
 */
async function capture(run: () => Promise<unknown>): Promise<Body> {
  const client = getAnthropicClient();
  const surface = client.messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const original = surface.create;
  let captured: Body | null = null;
  surface.create = (body: unknown) => {
    if (!captured) captured = body as Body;
    return Promise.resolve({
      content: [{ type: "text", text: COMPOSITE_JSON }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  try {
    await run();
  } catch {
    // Post-send failures are not this file's subject - the body is already held.
  } finally {
    surface.create = original;
  }
  if (!captured) throw new Error("the grading path never called messages.create");
  return captured;
}

function userBlocks(body: Body): Block[] {
  const messages = body.messages as { role: string; content: Block[] }[];
  const user = messages.find((m) => m.role === "user");
  assert(user, "no user message in the request body");
  return user!.content ?? [];
}

function userText(body: Body): string {
  return userBlocks(body)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("\n");
}

function imageBlockCount(body: Body): number {
  return userBlocks(body).filter((b) => b.type === "image").length;
}

// ── 1. AC3: what the second opinion actually receives ───────────────────────

Deno.test("US-3366: the second opinion's REQUEST carries the baseline, the tag block, the verification photos and the anchors", async () => {
  const body = await capture(() =>
    secondOpinionComposite(
      PER_IMAGE,
      GARMENT,
      BUCKET,
      SECOND_MODEL,
      EVIDENCE.baselineBlock,
      EVIDENCE.verificationImages,
      EVIDENCE.tagBlock,
      EVIDENCE.referenceAnchors,
    )
  );

  // The model is the second one, or this is not a second opinion at all.
  assertEquals(body.model, SECOND_MODEL);

  const text = userText(body);
  // The two TEXT evidence blocks. Before US-3366 neither of these reached the
  // second model: it graded the same garment against no baseline and no label.
  assertStringIncludes(
    text,
    BASELINE_SENTINEL,
    "the second opinion must read the same trusted baseline the primary did; " +
      "without it a disagreement measures the missing context, not the model",
  );
  assertStringIncludes(
    text,
    TAG_SENTINEL,
    "the second opinion must read the same transcribed label the primary did",
  );

  // The two IMAGE evidence sets: 1 reference anchor + 2 verification photos.
  assertEquals(
    imageBlockCount(body),
    EVIDENCE.referenceAnchors.length + EVIDENCE.verificationImages.length,
    "every photo the primary composite saw must be attached to the second one; " +
      "a photo one model saw and the other did not is the confound this feature " +
      "cannot tolerate",
  );
});

Deno.test("US-3366: the second opinion sends a BYTE-IDENTICAL prompt to the primary, differing only in the model", async () => {
  // The assertion that survives a future argument being added: rather than
  // naming what the prompt should contain, it pins that the two calls compile
  // the SAME surface from the same evidence. If someone adds a thirteenth piece
  // of context to the primary and not to the second opinion, this fails.
  const second = await capture(() =>
    secondOpinionComposite(
      PER_IMAGE,
      GARMENT,
      BUCKET,
      SECOND_MODEL,
      EVIDENCE.baselineBlock,
      EVIDENCE.verificationImages,
      EVIDENCE.tagBlock,
      EVIDENCE.referenceAnchors,
    )
  );
  const primaryShaped = await capture(() =>
    compositeGrade(
      PER_IMAGE,
      GARMENT,
      undefined,
      PRIMARY_MODEL,
      BUCKET,
      EVIDENCE.baselineBlock,
      EVIDENCE.verificationImages,
      false,
      EVIDENCE.tagBlock,
      false,
      false,
      EVIDENCE.referenceAnchors,
    )
  );

  assertEquals(
    JSON.stringify(second.system),
    JSON.stringify(primaryShaped.system),
    "the two composites must run the same system prompt",
  );
  assertEquals(
    JSON.stringify(second.messages),
    JSON.stringify(primaryShaped.messages),
    "the two composites must read the same user message, byte for byte",
  );
  // And they really are two distinct calls, not one captured twice.
  assert(second.model !== primaryShaped.model);
});

// ── 2. AC1: the two quality flags are a DIFFERENT decision, and why ─────────

Deno.test("US-3366: fabricCloseupMissing / labelIllegible change no byte of the prompt", async () => {
  // Which is the whole reason they are passed as false rather than forwarded.
  // They are output policy (a cap, a forced review, a countable event), not
  // evidence, so withholding them costs the second read nothing.
  const off = await capture(() =>
    compositeGrade(
      PER_IMAGE,
      GARMENT,
      undefined,
      SECOND_MODEL,
      BUCKET,
      EVIDENCE.baselineBlock,
      EVIDENCE.verificationImages,
      false,
      EVIDENCE.tagBlock,
      false,
      false,
      EVIDENCE.referenceAnchors,
    )
  );
  const on = await capture(() =>
    compositeGrade(
      PER_IMAGE,
      GARMENT,
      undefined,
      SECOND_MODEL,
      BUCKET,
      EVIDENCE.baselineBlock,
      EVIDENCE.verificationImages,
      false,
      EVIDENCE.tagBlock,
      true,
      true,
      EVIDENCE.referenceAnchors,
    )
  );
  assertEquals(
    JSON.stringify(on.system),
    JSON.stringify(off.system),
    "these flags must not reach the prompt; if they ever do, they become " +
      "EVIDENCE and the second opinion has to carry them",
  );
  assertEquals(
    JSON.stringify(on.messages),
    JSON.stringify(off.messages),
    "these flags must not reach the prompt; if they ever do, they become " +
      "EVIDENCE and the second opinion has to carry them",
  );
});

Deno.test("US-3366: a true quality flag is UNREACHABLE at the second-opinion call site", () => {
  // The other half of passing false: either flag forces human review on the
  // primary, and the trigger refuses anything already routed to a person. So
  // the second opinion cannot run on a submission where these are true.
  const cases: Array<
    [string, { fabricCloseupMissing?: boolean; labelIllegible?: boolean }]
  > = [
    ["fabricCloseupMissing", { fabricCloseupMissing: true }],
    ["labelIllegible", { labelIllegible: true }],
  ];
  for (const [flag, extra] of cases) {
    const policy = applyGradingConfidencePolicy({
      confidenceScore: 0.8,
      authenticityFlagged: false,
      defaultedFactorCount: 0,
      reviewThreshold: 0.75,
      ...extra,
    });
    assertEquals(
      policy.needsHumanReview,
      true,
      `${flag} must force review, or passing false below stops being safe`,
    );
    const decision = shouldSeekSecondOpinion(
      {
        confidence: policy.finalConfidence,
        itemValue: null,
        alreadyNeedsReview: policy.needsHumanReview,
      },
      { ...DEFAULT_SECOND_OPINION_CONFIG, enabled: true },
    );
    assertEquals(
      decision.trigger,
      false,
      `a ${flag} grade is already going to a human, so no second opinion is sought`,
    );
  }
});

// ── 3. AC4: the drift guard, derived from the signature + both call sites ───

const PIPELINE_PATH = new URL("../lib/grading-pipeline.ts", import.meta.url);
const AI_GRADING_PATH = new URL("../lib/ai-grading.ts", import.meta.url);

/**
 * Replace every comment with spaces of the SAME length, so indices into the
 * original source still line up. String- and template-aware, because blanking
 * a `//` inside a URL literal would corrupt the code being parsed.
 */
function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // Comments are tested BEFORE quotes, and the order is load-bearing: an
    // apostrophe inside a comment ("the candidate leg doesn't") would otherwise
    // open a string that swallows the rest of the file, and the guard then reads
    // comment prose as an argument. That is exactly how it failed first.
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < src.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === quote) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Top-level, comma-separated members of the bracket group starting at `open`. */
function splitGroup(src: string, open: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        parts.push(cur);
        break;
      }
    } else if (ch === "," && depth === 1) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  return parts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** The declared name of one parameter, e.g. "verificationImages" from
 * "verificationImages: VerificationImage[] = []". */
function paramName(p: string): string {
  const m = /^([A-Za-z_$][\w$]*)/.exec(p);
  assert(m, `could not read a parameter name from "${p}"`);
  return m[1];
}

/**
 * Comments are blanked inside a SLICE, never across the whole file.
 *
 * The first version of this guard scanned all 3,700 lines of ai-grading.ts and
 * desynced on a backtick somewhere in the prompt constants, which left the
 * signature unblanked and made the guard read comment prose as a parameter. A
 * few-kilobyte window around the thing being parsed has no such hazard, and a
 * window that is too small fails loudly rather than quietly.
 */
function region(src: string, at: number): string {
  return blankComments(src.slice(at, at + 6000));
}

/** The argument expressions of the `compositeGrade(` call after `marker`. */
function callArgs(src: string, marker: string): string[] {
  const at = src.indexOf(marker);
  assert(at >= 0, `call-site marker not found: ${marker}`);
  assertEquals(
    src.indexOf(marker, at + 1),
    -1,
    `call-site marker must appear exactly once: ${marker}`,
  );
  const window = region(src, at);
  const call = window.indexOf("compositeGrade(");
  assert(call >= 0, `no compositeGrade( call after marker ${marker}`);
  return splitGroup(window, call + "compositeGrade".length);
}

/**
 * Positions that are ALLOWED to differ, keyed by the parameter name the
 * signature gives them, each with the reason. A key that stops diverging fails
 * too, so this map can only ever shrink.
 */
const EXPECTED_DIVERGENCE: Record<string, string> = {
  modelOverride:
    "the point of the pass: a DIFFERENT model reads the same evidence",
  fabricCloseupMissing:
    "output policy, not evidence: it reaches no prompt, the second read's " +
      "confidence is discarded, and passing it true would double-count US-2397's " +
      "grading.no_fabric_closeup event for one submission",
  labelIllegible:
    "same as fabricCloseupMissing, for US-3320's grading.illegible_label",
};

Deno.test("US-3366 GUARD: the two composite call sites pass the same arguments", async () => {
  const pipelineSrc = await Deno.readTextFile(PIPELINE_PATH);
  const aiSrc = await Deno.readTextFile(AI_GRADING_PATH);

  // The parameter NAMES come from compositeGrade itself. Nothing here is a
  // hand-written list of arguments, so adding one cannot be missed.
  const sigAt = aiSrc.indexOf("export async function compositeGrade(");
  assert(sigAt >= 0, "compositeGrade signature not found");
  const sig = region(aiSrc, sigAt);
  const params = splitGroup(sig, sig.indexOf("(")).map(paramName);
  assert(params.length >= 5, `expected a long parameter list, got ${params.length}`);

  const primary = callArgs(pipelineSrc, "[composite-call: primary]");
  const second = callArgs(pipelineSrc, "[composite-call: second-opinion]");

  // THE ARITY RULE. This is the one that fails when the primary gains an
  // argument the second opinion does not, the drift US-3366 was filed for.
  assertEquals(
    primary.length,
    params.length,
    "the primary composite must pass every declared argument explicitly",
  );
  assertEquals(
    second.length,
    params.length,
    "the second opinion must pass every declared argument explicitly; a short " +
      "argument list is indistinguishable from a deliberate one, and last time " +
      "it was an oversight",
  );

  const diverged: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const name = params[i];
    if (primary[i] === second[i]) continue;
    diverged.push(name);
    assert(
      name in EXPECTED_DIVERGENCE,
      `composite argument #${i + 1} (${name}) differs between the primary ` +
        `(${primary[i]}) and the second opinion (${second[i]}) with no recorded ` +
        `reason. Either pass the same expression or add it to ` +
        `EXPECTED_DIVERGENCE with why.`,
    );
  }
  // The list can only shrink: an entry that stopped diverging is stale.
  for (const name of Object.keys(EXPECTED_DIVERGENCE)) {
    assert(
      diverged.includes(name),
      `EXPECTED_DIVERGENCE lists "${name}" but the two call sites now agree ` +
        `there. Drop the entry rather than leave a reason nobody can check.`,
    );
  }
});

/**
 * US-3366 GUARD 2: the CALLER fills the second opinion from the primary's own
 * locals.
 *
 * Guard 1 proves the FUNCTION forwards everything it is given. This proves the
 * pipeline gives it the right things. Without it the gap is real and was proved
 * by sabotage: hand the helper "" for the baseline and guard 1 still passes (the
 * arity is unchanged) and so do the request tests (they drive the function with
 * their own fixture, not the pipeline's variables).
 *
 * Everything below is derived: compositeGrade's parameter names, the helper's
 * parameter names, and the three argument lists. No list of names is written here.
 */
Deno.test("US-3366 GUARD: the pipeline fills the second opinion from the primary's own locals", async () => {
  const src = await Deno.readTextFile(PIPELINE_PATH);
  const aiSrc = await Deno.readTextFile(AI_GRADING_PATH);

  const sigAt = aiSrc.indexOf("export async function compositeGrade(");
  assert(sigAt >= 0, "compositeGrade signature not found");
  const sig = region(aiSrc, sigAt);
  const params = splitGroup(sig, sig.indexOf("(")).map(paramName);

  const primary = callArgs(src, "[composite-call: primary]");
  const forwarded = callArgs(src, "[composite-call: second-opinion]");

  const helperAt = src.indexOf("export function secondOpinionComposite(");
  assert(helperAt >= 0, "secondOpinionComposite was not found");
  const helperSig = region(src, helperAt);
  const helperParams = splitGroup(helperSig, helperSig.indexOf("(")).map(paramName);

  // helper parameter name -> the expression the PRIMARY passes in that slot.
  const expected = new Map<string, string>();
  for (let i = 0; i < params.length; i++) {
    if (params[i] in EXPECTED_DIVERGENCE) continue;
    if (helperParams.includes(forwarded[i])) expected.set(forwarded[i], primary[i]);
  }
  assert(
    expected.size >= 4,
    `expected at least the four evidence arguments to be forwarded through a ` +
      `parameter, found ${expected.size}`,
  );

  const callAt = src.indexOf("await secondOpinionComposite(");
  assert(callAt >= 0, "the pipeline never calls secondOpinionComposite");
  const callWindow = region(src, callAt);
  const actual = splitGroup(callWindow, callWindow.indexOf("("));
  assertEquals(
    actual.length,
    helperParams.length,
    "the pipeline must pass every parameter secondOpinionComposite declares",
  );
  for (const [name, want] of expected) {
    const at = helperParams.indexOf(name);
    assertEquals(
      actual[at],
      want,
      `secondOpinionComposite's "${name}" must be the same expression the ` +
        `primary composite receives (${want}), not ${actual[at]} - otherwise ` +
        `the second model grades from different evidence again`,
    );
  }
});
