// US-3146: every Anthropic call site either chooses an effort or is on a named
// list saying why not.
//
// WHY A SOURCE SCAN AND NOT A LIST OF THIRTEEN ASSERTIONS. The defect this
// story fixes was never "these thirteen call sites are wrong". It was that
// output_config is OPTIONAL, its absence is invisible, and Sonnet 5's default
// is `high` - so a call site written by copying the one above it inherits the
// most expensive setting in the API and nothing anywhere says so. A test that
// pins thirteen files would pass forever while the fourteenth is added.
//
// So the scan is exhaustive and the exceptions are enumerated. A new
// messages.create anywhere under src/ fails this test until somebody decides
// what effort it should run at - which is the whole point.
//
// THE REMAINING list is US-3147's work order and must only ever shrink.

import { assert, assertEquals } from "@std/assert";

const ROOTS = ["src/lib", "src/routes"];

/**
 * Call sites that deliberately do NOT use effortParams, each with the reason.
 * An entry here is a decision; an absence is an oversight. Removing an entry is
 * how US-3147 closes.
 */
const EXEMPT: Record<string, string> = {
  // The grading path has its own effort authority (GRADING_AI_EFFORT via
  // gradingSamplingParams) plus a prompt-version lifecycle that attributes a
  // grade to the configuration that produced it. A per-feature env var reaching
  // in here could move grades with no shadow compare. US-3146 AC4.
  "src/lib/ai-grading.ts": "grading: gradingSamplingParams is the only effort source",
  "src/lib/ai-authenticity.ts": "grading pipeline: shares gradingSamplingParams",
  "src/lib/ai-provider-anthropic.ts":
    "the provider adapter renders whatever effort the grading caller passed",
  // Already choosing an effort directly, from before the helper existed.
  "src/lib/content-ai-social.ts": "sets output_config.effort medium inline",
  "src/lib/content-safety.ts": "sets output_config.effort low inline",
  // US-3147 left this alone DELIBERATELY. garment-baselines generates the
  // brand/category brief that baselineReferenceBlock injects into the
  // per-image GRADING prompt as trusted ground truth (US-1533). Changing
  // its effort changes that text, which changes grades - so it belongs to
  // the grading lifecycle (shadow, eval, canary), not to a per-feature env
  // var. Its ledger slug, grading_baseline, is the tell.
  "src/lib/garment-baselines.ts":
    "grading-adjacent: writes the baseline block that enters the grading prompt",
};

/**
 * Still on Sonnet 5's default `high`. This is US-3147's scope: extraction,
 * listing generation, content writing and the agent loops - the calls where
 * lowering effort could actually be felt, so each needs a quality check rather
 * than a bulk edit.
 *
 * content-ai-stream.ts left this list early: US-3149 had to touch its request
 * builder anyway to pass a cached system block, so setting an effort there was
 * one line rather than a second visit.
 *
 * ⚠ ADD NOTHING HERE. A new entry means a new call site shipped at the default
 * without anybody deciding, which is the exact regression this file exists to
 * catch. Remove entries as US-3147 converts them.
 */
const REMAINING = new Set<string>([
  // US-3147 emptied this. It is kept, empty, on purpose: an empty set that the
  // "only shrinks" test still walks is a live guard, and deleting it would make
  // the next addition look like ordinary code rather than a regression.
]);

/** The thirteen this story converted. Named so the story's AC2 is checkable. */
const CONVERTED = [
  "src/lib/ai-tag-ocr.ts",
  "src/lib/ai-photo-roles.ts",
  "src/lib/ai-photo-qa.ts",
  "src/lib/ai-size-estimate.ts",
  "src/lib/ai-reconcile.ts",
  "src/lib/marketplace-category-resolve.ts",
  "src/lib/support-abuse.ts",
  "src/lib/measure-extract.ts",
  "src/lib/prospect-vision.ts",
  "src/lib/receipt-extract.ts",
  "src/lib/ai-group-propose.ts",
  "src/lib/ai-group-verify.ts",
];

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && p.endsWith(".ts") && !p.endsWith("_test.ts")) yield p;
  }
}

// Blank out comments, leaving code and string contents in place.
//
// THIS IS A SINGLE ORDERED PASS, NOT TWO REGEX REPLACES, AND THE REASON IS A
// BUG THIS TEST CAUGHT ON ITSELF. The first version stripped block comments
// first and line comments second. admin-drip.ts:32 is a LINE comment that
// mentions the route group "/api/admin/" followed by a star; the block-comment
// regex read that star-slash pair as an opening delimiter, hunted for its
// close, and found one 467 lines later inside the regex literal that strips
// code fences. Everything between vanished, including a real messages.create at
// :489 - so the file reported ZERO call sites and the scan called it converted.
// A guard that silently sees nothing is worse than no guard: it reports success.
//
// Scanning left to right in one pass fixes it by construction: at :32 we are
// already inside a line comment when that star arrives, so it opens nothing.
// String and template literals are tracked for the same reason - a URL in a
// string must not start a comment. Regex literals are NOT tracked, which is
// safe here only because an escaped slash never yields two adjacent slashes.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "'" | '"' | "`";
  let state: State = "code";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") state = c as State;
      out += c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i += 2; continue; }
      // Keep newlines so reported line numbers stay meaningful.
      if (c === "\n") out += c;
      i++;
      continue;
    }
    // Inside a string or template literal: copy verbatim, honour escapes.
    if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
    if (c === state) state = "code";
    out += c;
    i++;
  }
  return out;
}

function callBodies(rawSrc: string): string[] {
  const src = stripComments(rawSrc);
  const out: string[] = [];
  const re = /\.messages\.(create|stream)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the "("
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

const chooses = (body: string) =>
  body.includes("effortParams(") ||
  body.includes("output_config") ||
  body.includes("gradingSamplingParams(") ||
  body.includes("outputConfig");

async function scan() {
  const withCalls = new Map<string, string[]>();
  for (const root of ROOTS) {
    for await (const path of walk(root)) {
      const src = await Deno.readTextFile(path);
      const bodies = callBodies(src);
      if (bodies.length > 0) withCalls.set(path.replace(/\\/g, "/"), bodies);
    }
  }
  return withCalls;
}

Deno.test("US-3146: every Anthropic call site chooses an effort or is named", async () => {
  const files = await scan();
  assert(files.size > 20, `scan found only ${files.size} files - it broke`);

  const undecided: string[] = [];
  for (const [path, bodies] of files) {
    if (EXEMPT[path]) continue;
    if (REMAINING.has(path)) continue;
    if (!bodies.every(chooses)) {
      undecided.push(
        `${path}: ${bodies.filter((b) => !chooses(b)).length} of ${bodies.length} ` +
          `call(s) send no output_config, so they run Sonnet 5's default effort ` +
          `(high). Add ...effortParams(model, "<feature>", "low"|"medium"), or ` +
          `add the file to EXEMPT or REMAINING with a reason.`,
      );
    }
  }
  assertEquals(undecided, [], undecided.join("\n"));
});

Deno.test("US-3146 AC2: the thirteen converted sites all pass effortParams", () => {
  // Named individually so the story's acceptance criterion is the assertion,
  // not a summary of it. The scan above would also catch a regression here,
  // but it would not say WHICH promise was broken.
  const missing: string[] = [];
  for (const path of CONVERTED) {
    const src = Deno.readTextFileSync(path);
    const bodies = callBodies(src);
    assert(bodies.length > 0, `${path}: no messages.create found - path moved?`);
    for (const b of bodies) {
      if (!b.includes("effortParams(")) missing.push(path);
    }
  }
  assertEquals(missing, []);
});

Deno.test("US-3146 AC4: the grading path is untouched by the shared helper", () => {
  // The grading files must keep gradingSamplingParams as their ONLY effort
  // source. effortParams reads AI_EFFORT_<FEATURE>, which no grading eval, no
  // prompt_version suffix and no shadow compare knows about - so a grade could
  // move on an env var with nothing recording that it had.
  for (
    const path of [
      "src/lib/ai-grading.ts",
      "src/lib/ai-authenticity.ts",
      "src/lib/ai-provider-anthropic.ts",
    ]
  ) {
    const src = Deno.readTextFileSync(path);
    assert(
      !src.includes("effortParams("),
      `${path} must not use the non-grading effort helper (US-3146 AC4)`,
    );
  }
});

Deno.test("REMAINING only shrinks: every entry still has an undecided call", async () => {
  // A stale entry is as bad as a missing one. If a file here has since been
  // converted (or lost its Anthropic call), the list has to lose it, or
  // US-3147's work order silently overstates what is left.
  const files = await scan();
  const stale: string[] = [];
  for (const path of REMAINING) {
    const bodies = files.get(path);
    if (!bodies) {
      stale.push(`${path}: no Anthropic call here any more - drop it`);
      continue;
    }
    if (bodies.every(chooses)) {
      stale.push(`${path}: already chooses an effort - drop it from REMAINING`);
    }
  }
  assertEquals(stale, [], stale.join("\n"));
});
