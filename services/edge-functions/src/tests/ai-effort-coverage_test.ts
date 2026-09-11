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
 *
 * ⚠ AN ENTRY HERE MAKES THE FILE UNSCANNED, which is why "EXEMPT only shrinks"
 * below re-earns every line of this list on every run. Three entries were
 * already stale when that test was added: ai-grading.ts had no Anthropic call
 * left to exempt, and content-ai-social.ts / content-safety.ts had both moved
 * to outputConfigParams in US-3151 while their reasons still said "inline".
 * Those two files are now scanned like everything else and pass on their own.
 */
const EXEMPT: Record<string, string> = {
  // The grading path has its own effort authority (GRADING_AI_EFFORT via
  // gradingSamplingParams) plus a prompt-version lifecycle that attributes a
  // grade to the configuration that produced it. A per-feature env var reaching
  // in here could move grades with no shadow compare. US-3146 AC4.
  //
  // ai-grading.ts itself is NOT listed: it has no direct Anthropic call any
  // more, it goes through the provider adapter, so an exemption there would
  // suppress a scan of a file with nothing to scan. The AC4 test below still
  // asserts it never reaches for the shared helper, which is the real guard.
  "src/lib/ai-authenticity.ts": "grading pipeline: shares gradingSamplingParams",
  "src/lib/ai-provider-anthropic.ts":
    "the provider adapter renders whatever effort the grading caller passed",
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

// A call site the scanner can read has the paren right there:
// `.messages.create({...})`. A call site that takes a REFERENCE to the method
// and invokes it separately - a cast, an alias, a .bind - has no body at that
// position, so callBodies finds nothing and the file reports ZERO Anthropic
// calls. That is the admin-drip failure again in a different disguise: silence
// read as success. ai-provider-anthropic.ts:103 is exactly this shape today
// (`await (client.messages.create as unknown as (...) => ...)(body, opts)`),
// and it went unseen by this scan from the day it was written.
//
// It is EXEMPT, so nothing was running at the wrong effort. The cost is that
// the same three lines pasted into a NON-exempt file would also be invisible,
// and the guard would call that file converted. So the shape is counted, and a
// file carrying one has to be named rather than classified.
function referencedCallSites(rawSrc: string): number {
  const src = stripComments(rawSrc);
  return (src.match(/\.messages\.(?:create|stream)\b(?!\s*\()/g) ?? []).length;
}

// Does this call body RESOLVE AN EFFORT?
//
// ⚠ `output_config` ALONE IS NOT A DECISION, AND THIS USED TO ACCEPT IT.
// outputConfigParams exists (US-3151) precisely because
//     ...effortParams(model, "f", "low"),
//     output_config: { format: { type: "json_schema", schema } },
// compiles, runs, and drops the effort on the floor - one key, the later one
// wins. The result is a body that carries a format-only output_config, runs at
// the default `high`, and looks configured to anyone reading it. The old
// substring check passed that body, so the single most likely way to lose an
// effort setting was the one thing the guard was blind to.
//
// The question this file exists to ask is whether an EFFORT was chosen, so that
// is what is asked: a helper that emits one, or a literal `effort:` key.
// The two US-3146/US-3151 helpers that read AI_EFFORT_<FEATURE>. Reaching for
// either one is what "converted" means, and is what an EXEMPT entry promises
// the file does NOT do.
const SHARED_EFFORT_HELPERS = ["effortParams(", "outputConfigParams("];

const EFFORT_HELPERS = [
  ...SHARED_EFFORT_HELPERS,
  "gradingSamplingParams(",
];

const resolvesEffort = (body: string) =>
  EFFORT_HELPERS.some((h) => body.includes(h)) || /\beffort\s*:/.test(body);

interface FileScan {
  bodies: string[];
  referenced: number;
}

async function scan() {
  const withCalls = new Map<string, FileScan>();
  for (const root of ROOTS) {
    for await (const path of walk(root)) {
      const src = await Deno.readTextFile(path);
      const bodies = callBodies(src);
      const referenced = referencedCallSites(src);
      if (bodies.length > 0 || referenced > 0) {
        withCalls.set(path.replace(/\\/g, "/"), { bodies, referenced });
      }
    }
  }
  return withCalls;
}

// The classifier's own fixtures. CLAUDE.md's ui:check wrapper does the same
// thing for the same reason: a rule that stops firing is indistinguishable from
// a codebase with nothing left to find, so the rule is made to prove it still
// fires before a quiet scan is believed. Every row here is a shape that has
// actually been written in this service or is one autocomplete away from it.
const CLASSIFIER_FIXTURES: ReadonlyArray<
  { body: string; resolves: boolean; what: string }
> = [
  {
    body: `{ model, ...effortParams(model, "tag_ocr", "low"), messages }`,
    resolves: true,
    what: "effortParams",
  },
  {
    body: `{ model, ...outputConfigParams(model, "f", "low", S), messages }`,
    resolves: true,
    what: "outputConfigParams",
  },
  {
    body: `{ model, ...gradingSamplingParams(model), messages }`,
    resolves: true,
    what: "gradingSamplingParams",
  },
  {
    body: `{ model, output_config: { effort: "low" }, messages }`,
    resolves: true,
    what: "an inline effort key",
  },
  {
    body:
      `{ model, output_config: { format: { type: "json_schema", schema: S } }, messages }`,
    resolves: false,
    what: "a format-only output_config, which runs at the default high",
  },
  {
    body: `{ model, max_tokens: 1024, messages }`,
    resolves: false,
    what: "no output_config at all",
  },
];

Deno.test("the classifier still fires: every fixture shape is judged correctly", () => {
  const wrong: string[] = [];
  for (const f of CLASSIFIER_FIXTURES) {
    if (resolvesEffort(f.body) !== f.resolves) {
      wrong.push(
        `${f.what}: resolvesEffort said ${!f.resolves}, expected ${f.resolves}`,
      );
    }
  }
  assertEquals(wrong, [], wrong.join("\n"));
});

Deno.test("the scanner still sees a referenced call site, not just an invoked one", () => {
  // Both shapes, in one synthetic file, so a regex edit that loses either one
  // fails here rather than in six months' production bill.
  const src = [
    `const a = await client.messages.create({ model, messages });`,
    `const f = client.messages.create as unknown as (b: unknown) => void;`,
  ].join("\n");
  assertEquals(callBodies(src).length, 1, "the invoked shape went unseen");
  assertEquals(referencedCallSites(src), 1, "the referenced shape went unseen");
});

Deno.test("US-3146: every Anthropic call site chooses an effort or is named", async () => {
  const files = await scan();
  assert(files.size > 20, `scan found only ${files.size} files - it broke`);

  const undecided: string[] = [];
  for (const [path, { bodies, referenced }] of files) {
    if (EXEMPT[path]) continue;
    if (REMAINING.has(path)) continue;
    if (referenced > 0) {
      undecided.push(
        `${path}: ${referenced} call site(s) take a REFERENCE to ` +
          `messages.create/stream instead of invoking it in place, so this scan ` +
          `cannot read their request body and cannot tell what effort they run ` +
          `at. Invoke it directly, or add the file to EXEMPT with a reason.`,
      );
    }
    const blind = bodies.filter((b) => !resolvesEffort(b)).length;
    if (blind > 0) {
      undecided.push(
        `${path}: ${blind} of ${bodies.length} ` +
          `call(s) resolve no effort, so they run Sonnet 5's default effort ` +
          `(high). Add ...effortParams(model, "<feature>", "low"|"medium") - or ` +
          `outputConfigParams if the call also sends a schema, because a ` +
          `separate output_config key would silently overwrite the effort - or ` +
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
    const entry = files.get(path);
    if (!entry) {
      stale.push(`${path}: no Anthropic call here any more - drop it`);
      continue;
    }
    if (entry.bodies.every(resolvesEffort) && entry.referenced === 0) {
      stale.push(`${path}: already chooses an effort - drop it from REMAINING`);
    }
  }
  assertEquals(stale, [], stale.join("\n"));
});

Deno.test("EXEMPT only shrinks: every entry still exempts something real", async () => {
  // REMAINING has had an only-shrinks test since this file was written. EXEMPT
  // never did, and EXEMPT is the more dangerous of the two: a path in REMAINING
  // is still reported as outstanding work, while a path in EXEMPT is SKIPPED
  // ENTIRELY by the scan above. A stale exemption is therefore an unscanned
  // file, and it reads as a decision somebody made on purpose.
  //
  // Two ways an entry goes stale, both of which had already happened here:
  //   1. The file no longer has an Anthropic call at all. ai-grading.ts moved
  //      to the provider adapter and has had none for some time; its entry was
  //      exempting nothing, while implying the scan had looked and agreed.
  //   2. The file now uses the shared helper, which is what the exemption said
  //      it did not. content-ai-social.ts and content-safety.ts both moved to
  //      outputConfigParams in US-3151 and their reasons still read "sets
  //      output_config.effort inline". They needed no exemption any more, and
  //      keeping one meant nothing in either file was being scanned.
  //
  // So an EXEMPT entry now has to earn its place every run: the file exists, it
  // still has a call site, and it still does NOT use the non-grading helper -
  // which is the promise the exemption is making.
  const files = await scan();
  const stale: string[] = [];
  for (const [path, reason] of Object.entries(EXEMPT)) {
    assert(reason.trim().length > 0, `${path}: EXEMPT entry with no reason`);
    const entry = files.get(path);
    if (!entry) {
      stale.push(
        `${path}: no Anthropic call site here any more, so the exemption ` +
          `hides nothing and only suppresses the scan - drop it`,
      );
      continue;
    }
    if (entry.bodies.some((b) => SHARED_EFFORT_HELPERS.some((h) => b.includes(h)))) {
      stale.push(
        `${path}: now uses the shared non-grading effort helper, which is what ` +
          `this exemption says it does not ("${reason}"). Drop the entry and ` +
          `let the scan cover the file.`,
      );
    }
  }
  assertEquals(stale, [], stale.join("\n"));
});
