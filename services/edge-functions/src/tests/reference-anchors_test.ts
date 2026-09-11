// US-3335: awarded reference photos as visual anchors in the composite call.
// Flag off (or no passing eval) = byte-identical request; anchors on = labeled
// images in the trusted channel, "+anchors", and their own metering phase.
//
//   deno test --allow-net --allow-env --allow-read src/tests/reference-anchors_test.ts

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals, assertMatch } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { compositeGrade, type GarmentInfo, type PerImageAnalysis } from "../lib/ai-grading.ts";
import {
  ANCHOR_IMAGE_TOKENS_ESTIMATE,
  type AnchorCandidate,
  anchorLabel,
  pickAnchors,
  REFERENCE_ANCHOR_EVAL_SETTING,
  REFERENCE_ANCHORS_ADDENDUM,
  REFERENCE_ANCHORS_FLAG,
  referenceAnchorsActive,
  type ReferenceAnchor,
  splitAnchorUsage,
  submissionFolder,
} from "../lib/reference-anchors.ts";
import { type AnchorEvalCase, summarizeAnchorEval } from "../lib/reference-anchors-eval.ts";
import { bustSettingCache } from "../lib/system-settings.ts";

// ── picking ─────────────────────────────────────────────────────────────────

function cand(id: string, score: number, path: string, eligible = true): AnchorCandidate {
  return { id, storage_path: path, awarded_score: score, factor: null, garment_category: "jeans", eligible };
}

Deno.test("anchors spread across the scale: highest, lowest, then the widest gap", () => {
  const pool = [9, 8.5, 8, 7, 6, 5, 4].map((s, i) => cand(`a${i}`, s, `u${i}/s${i}/front.jpg`));
  assertEquals(pickAnchors(pool, 3, []).map((c) => c.awarded_score), [9, 7, 4]);
  assertEquals(pickAnchors(pool, 1, []).map((c) => c.awarded_score), [9]);
  assertEquals(pickAnchors(pool, 10, []).length, 7);
});

Deno.test("never an ineligible owner's photo, never the garment's own submission", () => {
  const pool = [
    cand("mine", 9, "owner/sub-1/detail_1.jpg"),
    cand("withdrawn", 8, "other/sub-2/front.jpg", false),
    cand("ok", 6, "other/sub-3/front.jpg"),
  ];
  const picked = pickAnchors(pool, 3, ["owner/sub-1/front.jpg", "owner/sub-1/back.jpg"]);
  assertEquals(picked.map((c) => c.id), ["ok"]);
  assertEquals(submissionFolder("a/b/c.jpg"), "a/b/");
  assertEquals(submissionFolder("flat.jpg"), null);
});

Deno.test("labels say NOT this garment and the awarded value", () => {
  assertEquals(
    anchorLabel({ awardedScore: 7, factor: null, garmentCategory: "jeans" }),
    "Reference photo, NOT this garment: another jeans whose overall grade was 7.0.",
  );
  assertMatch(anchorLabel({ awardedScore: 8.5, factor: "fabric_condition", garmentCategory: "sweater" }), /fabric condition scored 8\.5\./);
});

// ── metering ────────────────────────────────────────────────────────────────

const USAGE = { model: "m", inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 3, cacheWriteTokens: 4 };

Deno.test("anchor tokens get their own share, and the two shares sum to the call", () => {
  const { composite, anchors } = splitAnchorUsage(USAGE, 3);
  assertEquals(anchors!.inputTokens, 3 * ANCHOR_IMAGE_TOKENS_ESTIMATE);
  assertEquals(composite.inputTokens + anchors!.inputTokens, USAGE.inputTokens);
  assertEquals(anchors!.outputTokens, 0);
  assertEquals(composite.outputTokens, USAGE.outputTokens);
  // Never more than was billed.
  assertEquals(splitAnchorUsage({ ...USAGE, inputTokens: 100 }, 3).anchors!.inputTokens, 100);
  assertEquals(splitAnchorUsage(USAGE, 0), { composite: USAGE, anchors: null });
});

// ── the two locks ───────────────────────────────────────────────────────────

// supabaseAdmin resolves `fetch` ONCE, on first use, and keeps it. So the stub
// is installed once and reads a variable; swapping stubs per step would leave
// the client talking to whichever stub it met first.
let settingValue: unknown = undefined;
const realFetch = globalThis.fetch;
function installSettingStub() {
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isSetting = url.includes("/rest/v1/system_settings") && url.includes(REFERENCE_ANCHOR_EVAL_SETTING);
    const rows = isSetting && settingValue !== undefined ? [{ value: settingValue }] : [];
    // maybeSingle asks for a list on GET, or an object when it says so.
    const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
    const body = wantsObject ? rows[0] ?? null : rows;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}

async function withSetting(value: unknown, fn: () => Promise<void>) {
  settingValue = value;
  bustSettingCache(REFERENCE_ANCHOR_EVAL_SETTING);
  try {
    await fn();
  } finally {
    settingValue = undefined;
    bustSettingCache(REFERENCE_ANCHOR_EVAL_SETTING);
  }
}

Deno.test("anchors serve only with the flag on AND a passing eval", async () => {
  const before = Deno.env.get(REFERENCE_ANCHORS_FLAG);
  installSettingStub();
  try {
    Deno.env.delete(REFERENCE_ANCHORS_FLAG);
    await withSetting({ passed: true }, async () => assertEquals(await referenceAnchorsActive(), false));
    Deno.env.set(REFERENCE_ANCHORS_FLAG, "1");
    await withSetting(undefined, async () => assertEquals(await referenceAnchorsActive(), false));
    await withSetting({ passed: false }, async () => assertEquals(await referenceAnchorsActive(), false));
    await withSetting({ passed: true }, async () => assertEquals(await referenceAnchorsActive(), true));
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) Deno.env.delete(REFERENCE_ANCHORS_FLAG);
    else Deno.env.set(REFERENCE_ANCHORS_FLAG, before);
  }
});

// ── the request ─────────────────────────────────────────────────────────────

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PER_IMAGE = {
  image_type: "front",
  detected_issues: [],
  style_attributes: [],
  condition_signals: [],
  estimated_scores: {
    fabric_condition: 8, structural_integrity: 8, cosmetic_appearance: 8, functional_elements: 8, odor_cleanliness: 8,
  },
  prompt_version: "per_image_v2",
} as unknown as PerImageAnalysis;
const REPLY = JSON.stringify({
  overall_score: 8,
  grade_tier: "Excellent",
  factor_scores: {
    fabric_condition: 8, structural_integrity: 8, cosmetic_appearance: 8, functional_elements: 8, odor_cleanliness: 8,
  },
  ai_summary: "ok",
  buyer_writeup: "ok",
  defects_found: [],
  style_attributes: [],
  confidence_score: 0.9,
  image_validity: { is_clothing: true, reason: "" },
});
const GARMENT: GarmentInfo = { garment_type: "bottoms", garment_category: "jeans", brand: null, title: "", description: null };
const ANCHORS: ReferenceAnchor[] = [
  { dataUri: TINY_PNG, awardedScore: 9, factor: null, garmentCategory: "jeans" },
  { dataUri: TINY_PNG, awardedScore: 5, factor: "fabric_condition", garmentCategory: "jeans" },
];

type Body = Record<string, unknown>;
async function send(
  call: () => Promise<unknown>,
): Promise<{ body: Body; result: Record<string, unknown> }> {
  const surface = getAnthropicClient().messages as unknown as { create: (...args: unknown[]) => unknown };
  const original = surface.create;
  let captured: Body | null = null;
  surface.create = (body: unknown) => {
    captured ??= body as Body;
    return Promise.resolve({
      content: [{ type: "text", text: REPLY }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 9000, output_tokens: 400 },
    });
  };
  try {
    const result = await call() as Record<string, unknown>;
    return { body: captured!, result };
  } finally {
    surface.create = original;
  }
}

Deno.test("no anchors: the request and the result are exactly the pre-anchor ones", async () => {
  const legacy = await send(() => compositeGrade([PER_IMAGE], GARMENT, undefined, undefined, undefined, "", [], true));
  const empty = await send(() =>
    compositeGrade([PER_IMAGE], GARMENT, undefined, undefined, undefined, "", [], true, "", false, false, [])
  );
  assertEquals(JSON.stringify(empty.body), JSON.stringify(legacy.body));
  assert(!String(empty.result.prompt_version).includes("+anchors"));
  assertEquals("anchor_usage" in empty.result, false);
  assertEquals("reference_anchor_count" in empty.result, false);
});

Deno.test("with anchors: labeled images lead, the addendum trails, +anchors, and the usage is split", async () => {
  const { body, result } = await send(() =>
    compositeGrade([PER_IMAGE], GARMENT, undefined, undefined, undefined, "", [], true, "", false, false, ANCHORS)
  );
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assertEquals(content[0].type, "text");
  assertEquals(content[0].text, anchorLabel(ANCHORS[0]));
  assertEquals(content[1].type, "image");
  assertEquals(content[2].text, anchorLabel(ANCHORS[1]));
  assertEquals(content[3].type, "image");
  const last = String(content[content.length - 1].text);
  assert(last.endsWith(REFERENCE_ANCHORS_ADDENDUM), "the addendum closes the prompt");
  assert(!last.includes("VISUAL VERIFICATION"), "no verification addendum without verification photos");
  assert(String(result.prompt_version).endsWith("+anchors"));
  assertEquals(result.reference_anchor_count, 2);
  const usage = result.usage as { inputTokens: number };
  const anchorUsage = result.anchor_usage as { inputTokens: number };
  assertEquals(usage.inputTokens + anchorUsage.inputTokens, 9000);
  assertEquals(anchorUsage.inputTokens, 2 * ANCHOR_IMAGE_TOKENS_ESTIMATE);
});

// ── the eval verdict ────────────────────────────────────────────────────────

function evalCase(expected: number, off: number, on: number | null, anchors = 2): AnchorEvalCase {
  return { case_id: crypto.randomUUID(), garment_category: "jeans", expected, off, on, anchors };
}

Deno.test("thin evidence fails, even when every case improved", () => {
  const v = summarizeAnchorEval([evalCase(7, 8, 7), evalCase(6, 7, 6)], 5);
  assertEquals(v.passed, false);
  assertMatch(v.reason, /Only 2/);
});

Deno.test("worse error fails; lower agreement fails; no worse passes", () => {
  const five = (off: number, on: number) => Array.from({ length: 5 }, () => evalCase(7, off, on));
  assertEquals(summarizeAnchorEval(five(7.2, 7.4)).passed, false);
  // Same average error, but anchors push every case just outside the 0.5 band.
  const mixed = [evalCase(7, 7.5, 7.6), evalCase(7, 7.5, 7.6), evalCase(7, 7.5, 7.6), evalCase(7, 8, 7.8), evalCase(7, 8, 7.8)];
  const m = summarizeAnchorEval(mixed);
  assertEquals(m.passed, false);
  assertMatch(m.reason, /agreement/);
  const good = summarizeAnchorEval(five(7.6, 7.2));
  assertEquals(good.passed, true);
  assertEquals(good.cases_with_anchors, 5);
});

Deno.test("cases without anchors, or that failed, are left out of the comparison", () => {
  const cases = [
    ...Array.from({ length: 5 }, () => evalCase(7, 7.2, 7.1)),
    evalCase(7, 9, null, 0),
    { ...evalCase(7, 9, 9), off: null, failed_reason: "download failed" },
  ];
  assertEquals(summarizeAnchorEval(cases).cases_with_anchors, 5);
});

// ── wiring ──────────────────────────────────────────────────────────────────

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url)).replace(/\r\n/g, "\n");

Deno.test("the pipeline loads anchors only behind both locks, from the item's own paths, and meters them", () => {
  const pipe = read("../lib/grading-pipeline.ts");
  assertMatch(
    pipe,
    /const referenceAnchors = await referenceAnchorsActive\(\)\n\s+\? await loadReferenceAnchors\(\n\s+submission\.garment_category,\n\s+images\.map\(\(i\) => i\.storage_path\),\n\s+\)\n\s+: \[\];/,
  );
  assert(pipe.includes("qualityGate.labelIllegible,\n      // US-3335: [] unless both locks are open -> byte-identical request.\n      referenceAnchors,\n    );"));
  assert(pipe.includes('phase: "composite_reference_anchors", usage: compositeResult.anchor_usage'));
});

Deno.test("the eval's two legs differ only by the anchors", () => {
  const ev = read("../lib/reference-anchors-eval.ts");
  assert(ev.includes('const off = await compositeGrade(perImage, garmentInfo, undefined, undefined, undefined, "", [], true);'));
  assertMatch(
    ev,
    /const on = await compositeGrade\(\n\s+perImage, garmentInfo, undefined, undefined, undefined, "", \[\], true,\n\s+"", false, false, anchors,\n\s+\);/,
  );
});

// ── the eval route ──────────────────────────────────────────────────────────

Deno.test("running the anchor eval needs step-up before any work", async () => {
  const { Hono } = await import("hono");
  const { adminGradingRoutes } = await import("../routes/admin-grading.ts");
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-000000000001");
    c.set("adminRole", "super_admin");
    c.set("authClaims", { aal: "aal1", amr: [] });
    await next();
  });
  app.route("/", adminGradingRoutes);
  const res = await app.request("/reference-anchors/eval", { method: "POST" });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "STEP_UP_REQUIRED");
});

Deno.test("verification photos without anchors: the verification request is unchanged", async () => {
  const { VISUAL_VERIFICATION_ADDENDUM } = await import("../lib/ai-grading.ts");
  const verification = [{ imageType: "front", dataUri: TINY_PNG }];
  const { body } = await send(() =>
    compositeGrade([PER_IMAGE], GARMENT, undefined, undefined, undefined, "", verification, true)
  );
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assertEquals(content[0].text, "Photo (front):");
  const last = String(content[content.length - 1].text);
  assert(last.endsWith(`\n\n${VISUAL_VERIFICATION_ADDENDUM}`), "the verification addendum still closes the prompt");
  assert(!last.includes(REFERENCE_ANCHORS_ADDENDUM), "no anchor addendum without anchors");
});
