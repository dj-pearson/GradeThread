// US-3322: the label re-read gets a chance to clear an illegible flag before
// the confidence cap is computed from it, on a STANDARD grade too.
//
// Before this, runRereadPass ran only inside the paid Forensic block, and the
// ILLEGIBLE_LABEL_CONFIDENCE_CAP input was the quality gate's first-pass view.
// So on a standard grade an illegible label reached the composite with no
// second look, and even on Forensic a label the sharper read DID read kept its
// cap. This drives the real runRereadPass against a stubbed SDK and a stubbed
// storage bucket, and counts the vision calls it makes.
//
//   deno test --allow-net --allow-env --allow-read --allow-ffi src/tests/label-reread-standard_test.ts

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import type { PerImageAnalysis } from "../lib/ai-grading.ts";
import { labelIllegibleFor } from "../lib/image-quality.ts";
import {
  labelRereadScope,
  runRereadPass,
  type ZoomImageRow,
} from "../lib/grading-pipeline.ts";
import { supabaseAdmin } from "../lib/supabase.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SCORES = {
  fabric_condition: 8,
  structural_integrity: 8,
  cosmetic_appearance: 8,
  functional_elements: 8,
  odor_cleanliness: 8,
};

/** What the sharper read says: the label is legible and the fiber is known. */
const REREAD_REPLY = JSON.stringify({
  detected_issues: [],
  style_attributes: [],
  condition_signals: [],
  estimated_scores: SCORES,
  unassessable_factors: [],
  fiber_content: [{ fiber: "cotton", pct: 100 }],
  quality: { blur: "none", lighting: "ok", framing: "full", legible: true },
});

function read(
  image_type: string,
  extra: Partial<PerImageAnalysis> = {},
): PerImageAnalysis {
  return {
    image_type,
    detected_issues: [],
    condition_signals: [],
    style_attributes: [],
    estimated_scores: SCORES,
    quality: { blur: "none", lighting: "ok", framing: "full", legible: true },
    fiber_content: [],
    ...extra,
  } as PerImageAnalysis;
}

/** A first pass with one illegible label AND one photo flagged as manipulated. */
function firstPass(): PerImageAnalysis[] {
  return [
    read("front", {
      authenticity: {
        manipulation_suspected: true,
        manipulation_confidence: 0.8,
        tells: ["cloned patch near hem"],
        screenshot_or_watermark: false,
        screenshot_watermark_reason: "",
      },
    } as Partial<PerImageAnalysis>),
    read("back"),
    read("label", {
      quality: { blur: "none", lighting: "ok", framing: "full", legible: false },
    }),
  ];
}

const ROWS: ZoomImageRow[] = [
  { image_type: "front", storage_path: "u/s/front.png" },
  { image_type: "back", storage_path: "u/s/back.png" },
  { image_type: "label", storage_path: "u/s/label.png" },
];

/**
 * Run runRereadPass with the SDK and the storage bucket stubbed. Returns the
 * merged reads and which image types were sent to the model.
 */
async function reread(
  scope: "full" | "illegible_labels",
): Promise<{ out: PerImageAnalysis[]; downloads: string[]; calls: number }> {
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const originalCreate = surface.create;
  let calls = 0;
  surface.create = (body: unknown) => {
    calls++;
    return Promise.resolve({
      content: [{ type: "text", text: REREAD_REPLY }],
      model: (body as Record<string, unknown>).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const downloads: string[] = [];
  const bytes = Uint8Array.from(atob(TINY_PNG_B64), (c) => c.charCodeAt(0));
  // supabaseAdmin is a Proxy onto a memoised client whose `storage` is a fresh
  // StorageClient per access, so the seam is the StorageClient PROTOTYPE's
  // `from`, restored in the finally below.
  const storageProto = Object.getPrototypeOf(supabaseAdmin.storage) as {
    from: (bucket: string) => unknown;
  };
  const originalFrom = storageProto.from;
  storageProto.from = (_bucket: string) => ({
    download: (path: string) => {
      downloads.push(path);
      return Promise.resolve({ data: new Blob([bytes]), error: null });
    },
  });
  try {
    const out = await runRereadPass(
      firstPass(),
      ROWS,
      { garment_type: "tops", garment_category: "tee" },
      [],
      undefined,
      undefined,
      scope,
    );
    return { out, downloads, calls };
  } finally {
    surface.create = originalCreate;
    storageProto.from = originalFrom;
  }
}

const cap = (rs: PerImageAnalysis[]) =>
  labelIllegibleFor(rs.map((r) => ({ image_type: r.image_type, quality: r.quality })));

Deno.test("scope: Forensic keeps the full pass; a standard grade re-reads only an illegible label", () => {
  assertEquals(labelRereadScope(true, [read("front")]), "full");
  assertEquals(labelRereadScope(false, firstPass()), "illegible_labels");
  // A legible label with no fiber read is common, and stays paid work.
  assertEquals(labelRereadScope(false, [read("front"), read("label")]), "none");
  // An authenticity flag alone is paid work too.
  assertEquals(labelRereadScope(false, [firstPass()[0], read("label")]), "none");
});

Deno.test("standard scope: ONE vision call, on the label only, and the merged read clears the cap", async () => {
  assert(cap(firstPass()), "precondition: the first pass would cap");
  const { out, downloads, calls } = await reread("illegible_labels");
  assertEquals(calls, 1, "exactly one extra vision call");
  assertEquals(downloads, ["u/s/label.png"], "only the label's original was fetched");
  const label = out.find((r) => r.image_type === "label")!;
  assertEquals(label.quality?.legible, true, "the sharper read's legibility was merged");
  assertEquals(cap(out), false, "the cap computed from the MERGED read is off");
  // The authenticity flag is untouched: that re-read is not standard-grade work.
  const front = out.find((r) => r.image_type === "front")!;
  assertEquals(front.authenticity?.tells, ["cloned patch near hem"]);
});

Deno.test("full scope is unchanged: the label AND the flagged photo are re-read", async () => {
  const { downloads, calls } = await reread("full");
  assertEquals(calls, 2);
  assertEquals(downloads.sort(), ["u/s/front.png", "u/s/label.png"]);
});

// Wiring: the primary composite call must take the cap from the merged reads.
// A scan is right for where a value is wired (mode 0 of guards-that-do-not-
// guard) and this is exactly that question.
Deno.test("the primary composite no longer takes the label cap from the pre-re-read gate", () => {
  const raw = Deno.readTextFileSync(new URL("../lib/grading-pipeline.ts", import.meta.url));
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert(
    !code.includes("qualityGate.labelIllegible"),
    "a composite call reads the gate's first-pass label flag again, so a label " +
      "the re-read could read keeps ILLEGIBLE_LABEL_CONFIDENCE_CAP (US-3322)",
  );
  const standardRereads = code.match(/"illegible_labels",\s*\)/g) ?? [];
  assertEquals(
    standardRereads.length,
    2,
    "both the first pass and the escalation run the standard-grade label re-read",
  );
});
