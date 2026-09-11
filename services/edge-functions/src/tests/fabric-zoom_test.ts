// US-3338: the light fabric-zoom pass.
//
//   deno test --allow-net --allow-env --allow-read src/tests/fabric-zoom_test.ts

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals, assertMatch } from "@std/assert";
import { Image } from "imagescript";
import { type DetectedIssue, type PerImageAnalysis, promptVersionSuffix } from "../lib/ai-grading.ts";
import {
  FABRIC_ZOOM_MAX_NEW,
  FABRIC_ZOOM_PHASE,
  fabricZoomDecision,
  fabricZoomSpentTodayUsd,
  mapTileBbox,
  mergeFabricZoom,
  pickFabricCloseup,
  runFabricZoomPass,
  sumSpend,
  tileRects,
} from "../lib/fabric-zoom.ts";

// ── when it runs ────────────────────────────────────────────────────────────

const GO = { enabled: true, forensic: false, spentTodayUsd: 1, capUsd: 5, hasCloseup: true };

Deno.test("runs only with the flag on, no Forensic, a close-up, and room under the cap", () => {
  assertEquals(fabricZoomDecision(GO).run, true);
  assertEquals(fabricZoomDecision({ ...GO, enabled: false }).run, false);
  assertMatch(fabricZoomDecision({ ...GO, forensic: true }).reason, /forensic/);
  assertEquals(fabricZoomDecision({ ...GO, hasCloseup: false }).run, false);
  assertEquals(fabricZoomDecision({ ...GO, spentTodayUsd: 5 }).run, false, "at the cap is over the cap");
  assertEquals(fabricZoomDecision({ ...GO, capUsd: 0 }).run, false, "a zero cap means off");
  assertEquals(fabricZoomDecision({ ...GO, spentTodayUsd: Number.POSITIVE_INFINITY }).run, false);
});

Deno.test("the fabric close-up: detail:fabric wins, else the first detail shot", () => {
  const rows = [
    { image_type: "front", storage_path: "a" },
    { image_type: "detail", image_role: "detail:hardware", storage_path: "b" },
    { image_type: "detail_2", image_role: "detail:fabric", storage_path: "c" },
  ];
  assertEquals(pickFabricCloseup(rows)?.storage_path, "c");
  assertEquals(pickFabricCloseup(rows.slice(0, 2))?.storage_path, "b");
  assertEquals(pickFabricCloseup([{ image_type: "front", storage_path: "a" }]), null);
});

Deno.test("spend sums the phase's cost rows, and an unreadable ledger fails closed", async () => {
  assertEquals(sumSpend([{ cost_usd: "0.5" }, { cost_usd: 1.25 }, { cost_usd: null }]), 1.75);
  // supabaseAdmin binds fetch on first use, so this must be the file's first
  // database call; the counter proves the stub, not a real server, answered.
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
  }) as typeof fetch;
  try {
    assertEquals(await fabricZoomSpentTodayUsd(), Number.POSITIVE_INFINITY);
    assert(calls > 0, "the ledger read never reached the stub");
  } finally {
    globalThis.fetch = real;
  }
});

// ── tiling ──────────────────────────────────────────────────────────────────

function covers(W: number, H: number) {
  const tiles = tileRects(W, H);
  assertEquals(tiles.reduce((s, t) => s + t.w * t.h, 0), W * H, `${W}x${H} tiles must cover the image exactly`);
  return tiles;
}

Deno.test("a phone photo becomes four tiles that cover it exactly", () => {
  const tiles = covers(4032, 3024);
  assertEquals(tiles.length, 4);
  for (const t of tiles) assert(t.w <= 2016 && t.h <= 1512);
  assertEquals(covers(1500, 1000).length, 1, "already small enough: one tile, no split");
  assert(covers(9000, 1200).length <= 4, "never past the tile cap");
  assertEquals(tileRects(0, 100), []);
});

Deno.test("a tile's box maps back onto the whole image", () => {
  const tile = { x: 2016, y: 1512, w: 2016, h: 1512 };
  assertEquals(mapTileBbox([0.5, 0.5, 0.1, 0.1], tile, 4032, 3024), [0.75, 0.75, 0.05, 0.05]);
});

// ── merging ─────────────────────────────────────────────────────────────────

function issue(over: Partial<DetectedIssue>): DetectedIssue {
  return { issue: "hole", severity: "minor", size_bucket: "pinhole", location: "", is_intentional: false, ...over };
}
function analysis(issues: DetectedIssue[], image_type = "detail"): PerImageAnalysis {
  return {
    image_type,
    detected_issues: issues,
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 8, structural_integrity: 8, cosmetic_appearance: 8, functional_elements: 8, odor_cleanliness: 8,
    },
    prompt_version: "per_image_v2",
  } as unknown as PerImageAnalysis;
}
const WHOLE = { x: 0, y: 0, w: 1000, h: 1000 };

Deno.test("a tile flaw on a known flaw refines it through the zoom merge", () => {
  const target = analysis([issue({ issue: "pill", severity: "minor", bbox: [0.4, 0.4, 0.1, 0.1] })]);
  const read = analysis([issue({ issue: "pill", severity: "moderate", size_bucket: "small", bbox: [0.42, 0.42, 0.05, 0.05] })]);
  const out = mergeFabricZoom(target, [{ tile: WHOLE, read }], 1000, 1000);
  assertEquals(out.detected_issues.length, 1);
  assertEquals(out.detected_issues[0].severity, "moderate");
  assertEquals(out.detected_issues[0].zoom_refined, true);
  assert(out.prompt_version!.endsWith("+fabriczoom"));
});

Deno.test("a new flaw is added only when small, genuine and localized, and never past the cap", () => {
  const target = analysis([]);
  const read = analysis([
    issue({ bbox: [0.1, 0.1, 0.01, 0.01] }),
    issue({ size_bucket: "medium", bbox: [0.6, 0.6, 0.1, 0.1] }),
    issue({ is_intentional: true, bbox: [0.3, 0.3, 0.01, 0.01] }),
    issue({ bbox: null }),
  ]);
  const out = mergeFabricZoom(target, [{ tile: WHOLE, read }], 1000, 1000);
  assertEquals(out.detected_issues.length, 1);
  assertEquals((out.detected_issues[0] as { found_by?: string }).found_by, "fabric_zoom");

  const many = analysis(Array.from({ length: 12 }, (_, i) => issue({ bbox: [i * 0.08, 0.9, 0.01, 0.01] })));
  assertEquals(mergeFabricZoom(target, [{ tile: WHOLE, read: many }], 1000, 1000).detected_issues.length, FABRIC_ZOOM_MAX_NEW);
});

Deno.test("no tile read: the analysis is returned untouched and unstamped", () => {
  const target = analysis([issue({ bbox: [0.1, 0.1, 0.1, 0.1] })]);
  assertEquals(mergeFabricZoom(target, [], 1000, 1000), target);
});

// ── the pass, end to end with fake deps ─────────────────────────────────────

async function photo(W: number, H: number): Promise<Uint8Array> {
  return await new Image(W, H).fill(0x808080ff).encodeJPEG(80);
}

Deno.test("the pass reads each tile once at no more than 1568 px, merges, and returns the usages", async () => {
  const bytes = await photo(4032, 3024);
  const seen: Array<{ w: number; h: number }> = [];
  const results = [analysis([], "front"), analysis([])];
  const out = await runFabricZoomPass(
    results,
    { image_type: "detail", storage_path: "u/s/detail.jpg", original_storage_path: "u/s/orig.jpg" },
    {
      download: (path) => Promise.resolve(path === "u/s/orig.jpg" ? bytes : null),
      analyze: async (uri) => {
        const img = await Image.decode(Uint8Array.from(atob(uri.split(",")[1]), (c) => c.charCodeAt(0)));
        seen.push({ w: img.width, h: img.height });
        const read = analysis([issue({ bbox: [0.5, 0.5, 0.01, 0.01] })]);
        return { ...read, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    },
  );
  assertEquals(out.tiles, 4, "4032 x 3024 splits 2 x 2, each 2016 x 1512 before the shrink");
  assert(seen.every((s) => Math.max(s.w, s.h) <= 1568));
  assertEquals(out.usages.length, 4);
  assertEquals(out.results[0], results[0], "other photos are not touched");
  assertEquals(out.results[1].detected_issues.length, 4);
  assert(out.results[1].prompt_version!.endsWith("+fabriczoom"));
});

Deno.test("a failed download or every tile failing leaves the grade exactly as it was", async () => {
  const results = [analysis([])];
  const closeup = { image_type: "detail", storage_path: "p" };
  const none = await runFabricZoomPass(results, closeup, {
    download: () => Promise.resolve(null),
    analyze: () => Promise.reject(new Error("unreachable")),
  });
  assertEquals(none, { results, usages: [], tiles: 0 });
  const bytes = await photo(800, 600);
  const failing = await runFabricZoomPass(results, closeup, {
    download: () => Promise.resolve(bytes),
    analyze: () => Promise.reject(new Error("vision down")),
  });
  assertEquals(failing.results, results);
  assertEquals(failing.tiles, 0);
});

// ── the stamp ───────────────────────────────────────────────────────────────

Deno.test("+fabriczoom is appended last in the grade suffix chain", () => {
  const all = { baseline: true, fabric: true, visual: true, tag: true, categoryV2: true, roles: true, cleanliness: true, schemaSystem: true, scale: true, anchors: true };
  assertEquals(promptVersionSuffix({ ...all, fabricZoom: true }), promptVersionSuffix(all) + "+fabriczoom");
  assertEquals(promptVersionSuffix({ ...all, fabricZoom: false }), promptVersionSuffix(all));
  const src = Deno.readTextFileSync(new URL("../lib/ai-grading.ts", import.meta.url)).replace(/\r\n/g, "\n");
  assert(src.includes("const fabricZoom = perImageResults.some((r) =>\n    /\\+fabriczoom(?:\\+|$)/.test(r.prompt_version ?? \"\")\n  );"));
  assert(src.includes("    fabricZoom,\n  });"));
});

// ── Forensic is unchanged, and the pass is metered ──────────────────────────

Deno.test("Forensic keeps its own zoom exactly, and the light pass never runs on it", () => {
  const pipe = Deno.readTextFileSync(new URL("../lib/grading-pipeline.ts", import.meta.url)).replace(/\r\n/g, "\n");
  // The Forensic block is still the first thing after Step 4c, with its args.
  assertMatch(
    pipe,
    /if \(wantForensic\) \{\n\s+perImageResults = await runDefectZoomPass\(\n\s+perImageResults,\n\s+images as ZoomImageRow\[\],\n\s+submission,\n\s+styleHint,\n\s+submissionId,\n\s+firstPassModel,\n\s+\)/,
  );
  const forensicAt = pipe.indexOf("if (wantForensic) {\n      perImageResults = await runDefectZoomPass(");
  const fabricAt = pipe.indexOf("--- Step 4d (US-3338)");
  assert(forensicAt > 0 && fabricAt > forensicAt, "the light pass comes after Forensic, never instead of it");
  assert(pipe.includes("        forensic: wantForensic,\n"), "the decision is told whether this is a Forensic grade");
  assert(pipe.includes("...fabricZoomUsages.map((usage) => ({ phase: FABRIC_ZOOM_PHASE, usage })),"));
  assertEquals(FABRIC_ZOOM_PHASE, "per_image_fabric_zoom");
});
