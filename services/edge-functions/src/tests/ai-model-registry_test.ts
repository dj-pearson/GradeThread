// US-3112 found this red: the suite reaches src/lib/supabase.ts through its
// static imports, so it must seed the env before that module evaluates. It
// passed in every run that happened to load another test first.
import "./_env.ts";

// US-3186: the derived model surfaces may only name ids the registry knows.
//
// A model id used to be decided in twelve places. Seven of them are code in
// this service, and the failure they share is not that one is wrong: it is that
// a wrong one is INVISIBLE. A stale id is a real model, so calls succeed; a
// missing price row is not an error, so spend reads as $0.00; a stale
// lightweight prefix just reclassifies a report. None of them raises anything.
//
// So this suite asserts the two directions that matter:
//
//   VALUES  every id reachable from a derived surface is in the registry. A
//           surface that names something else is naming a model the registry
//           was not asked about, which is the twelve-places problem back.
//
//   SOURCE  no raw model-id literal reappears in code anywhere in the service.
//           This is the only half that can catch a NEW pin, because a new pin
//           with a plausible id would pass every value check.
//
// The source scan carries a positive control (it must find ids in the registry
// itself) so it cannot pass by matching nothing, and it excludes this file, so
// the ids quoted in the assertions below are not its own input.
//
// US-3347 WIDENED THE SOURCE HALF, and that is the part worth reading. It used
// to scan FOUR modules named in a const above: ai-config.ts, ai-usage.ts,
// ai-token-profile.ts and agent-kernel.ts. second-opinion.ts was the fifth
// module that defaults a model and it was not on the list, so it carried a raw
// "claude-opus-4-8" through the whole of US-3186 with the guard green. A list
// of files to scan is a second thing that can be wrong, it goes wrong silently,
// and its silence is indistinguishable from a clean codebase.
//
// So the scanned set is now the TREE: every .ts file under services/edge-
// functions except src/tests (test bodies name ids on purpose) and except the
// registry itself. Nothing has to be remembered when a file is added. The two
// exclusions fail in opposite directions and are handled accordingly -- a
// broken tests exclusion makes the scan RED and loud, while an exclusion that
// accidentally swallowed src/lib would make it quiet, so the set is asserted to
// still contain the five modules that actually default a model.

import { assert, assertEquals } from "@std/assert";
import {
  CURRENT_MODEL_IDS,
  CURRENT_MODELS,
  isKnownModelId,
  isLightweightModel,
  KNOWN_MODEL_IDS,
  LIGHTWEIGHT_MODEL_PREFIXES,
  MODEL_FAMILIES,
  MODEL_ID_PATTERN,
  MODEL_IDS,
  modelFamily,
  NON_ANTHROPIC_MODEL_IDS,
  RETAINED_MODEL_IDS,
  type RetainedSurface,
} from "../lib/ai-model-registry.ts";
import {
  classifyEffortSupport,
  CODE_DEFAULT_MODEL,
  CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
  GRADING_MODEL_ALLOWLIST,
  MODEL_TIERS,
  type ModelTier,
} from "../lib/ai-config.ts";
import { MODEL_PRICES } from "../lib/ai-usage.ts";
import { AGENT_MODEL_ALLOWLIST } from "../lib/agent-kernel.ts";
import { DEFAULT_SECOND_OPINION_CONFIG } from "../lib/second-opinion.ts";

const REGISTRY_MODULE = "../lib/ai-model-registry.ts";

function readModule(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, import.meta.url));
}

// -- The scanned set, derived from the tree (US-3347) --------------------------

/** services/edge-functions/: src, scripts, tools and anything added later. */
const SERVICE_ROOT = new URL("../../", import.meta.url);
/** Test bodies name model ids as fixtures and assertions; that is their job. */
const TESTS_DIR = new URL("../tests/", import.meta.url);
const REGISTRY_URL = new URL(REGISTRY_MODULE, import.meta.url);

/** Never walked: vendored or generated code nobody in this repo wrote. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "vendor"]);

function walkTypeScript(dir: URL, out: URL[] = []): URL[] {
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = new URL(`${entry.name}/`, dir);
      if (child.href === TESTS_DIR.href) continue;
      walkTypeScript(child, out);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(new URL(entry.name, dir));
    }
  }
  return out;
}

/** Walked once; three cases below read it. */
const SCANNED: readonly URL[] = walkTypeScript(SERVICE_ROOT)
  .filter((u) => u.href !== REGISTRY_URL.href);

/** Path relative to the service root, so a failure is something you can open. */
function shortPath(u: URL): string {
  return decodeURIComponent(u.href.slice(SERVICE_ROOT.href.length));
}

/**
 * The files that DEFAULT or RESOLVE a model, as of US-3347.
 *
 * Not the scan's input. The scan's input is the whole tree. This is the
 * over-exclusion control: if an exclusion, a skipped directory or a walk bug
 * ever quietly removes src/lib from the corpus, the scan would still report
 * nothing, and the way you find out is that these five stopped being in it.
 */
const MUST_BE_SCANNED = [
  "src/lib/ai-config.ts",
  "src/lib/ai-usage.ts",
  "src/lib/ai-token-profile.ts",
  "src/lib/agent-kernel.ts",
  "src/lib/second-opinion.ts",
] as const;

/**
 * Strip comments so a sentence ABOUT a model id is not read as a pin.
 *
 * Blocks first, as blocks, then whole-line and trailing `//`. Doing it by line
 * prefix alone leaves the interior of a block comment behind, and the interior
 * is exactly where a model id gets quoted in prose.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Anything shaped like a model id, in either provider's naming. */
const MODEL_ID_LITERAL = /\b(?:claude-[a-z0-9-]+|gpt-image-[0-9][a-z0-9-]*)\b/g;

function modelIdLiterals(src: string): string[] {
  return [...src.matchAll(MODEL_ID_LITERAL)].map((m) => m[0]);
}

// -- VALUES -------------------------------------------------------------------

Deno.test("US-3186: every derived surface names only ids the registry knows", () => {
  // Everything a model id can be read out of at runtime, with the name of the
  // surface, so a failure says which one to go and look at.
  const surfaces: Array<[string, Iterable<string>]> = [
    ["ai-config CURRENT_MODEL_IDS", CURRENT_MODEL_IDS],
    ["ai-config GRADING_MODEL_ALLOWLIST", GRADING_MODEL_ALLOWLIST],
    ["ai-config CONTENT_MODEL_ALLOWLIST", CONTENT_MODEL_ALLOWLIST_FOR_TESTS],
    ["ai-config CODE_DEFAULT_MODEL", [CODE_DEFAULT_MODEL]],
    [
      "ai-config MODEL_TIERS[*].codeDefault",
      Object.values(MODEL_TIERS).map((t) => t.codeDefault),
    ],
    ["ai-usage MODEL_PRICES keys", Object.keys(MODEL_PRICES)],
    ["agent-kernel AGENT_MODEL_ALLOWLIST", AGENT_MODEL_ALLOWLIST],
  ];

  for (const [name, ids] of surfaces) {
    for (const id of ids) {
      assert(
        isKnownModelId(id),
        `${name} names "${id}", which lib/ai-model-registry.ts does not know. ` +
          `Add it to MODEL_IDS (and to RETAINED_MODEL_IDS if it is a ` +
          `previous-generation id being kept on purpose) rather than pinning ` +
          `it at the use site - a twelfth copy is what US-3186 removed.`,
      );
    }
  }
});

Deno.test("US-3186: the tier defaults ARE the registry's current ids", () => {
  // DEFAULTS is not exported, so this reads it through the two things that are:
  // CODE_DEFAULT_MODEL and the tier table. If ai-config ever stops deriving
  // from CURRENT_MODELS, one of these stops matching.
  assertEquals(CODE_DEFAULT_MODEL, CURRENT_MODELS.default);

  const byTier: Record<ModelTier, string> = {
    default: CURRENT_MODELS.default,
    lightweight: CURRENT_MODELS.lightweight,
    sizeEstimate: CURRENT_MODELS.lightweight,
    platformVariant: CURRENT_MODELS.lightweight,
    photoQa: CURRENT_MODELS.lightweight,
    gradingComposite: CURRENT_MODELS.default,
    image: CURRENT_MODELS.image,
  };

  for (const [tier, expected] of Object.entries(byTier) as Array<[ModelTier, string]>) {
    assertEquals(
      MODEL_TIERS[tier].codeDefault,
      expected,
      `MODEL_TIERS.${tier}.codeDefault is not the registry value for its tier`,
    );
  }

  // And the tier table has not grown a tier this test forgot about: a new knob
  // with a hand-written codeDefault is the exact regression.
  assertEquals(
    Object.keys(MODEL_TIERS).sort(),
    Object.keys(byTier).sort(),
    "MODEL_TIERS gained or lost a tier; map it to a CURRENT_MODELS value above",
  );

  // Every tier default is a current id, not a retained one. Shipping with a
  // tier pointed at a retained id is how 2026-09-02 happened.
  for (const spec of Object.values(MODEL_TIERS)) {
    if (NON_ANTHROPIC_MODEL_IDS.has(spec.codeDefault)) continue;
    assert(
      CURRENT_MODEL_IDS.has(spec.codeDefault),
      `${spec.env} defaults to ${spec.codeDefault}, which is not a CURRENT id`,
    );
  }
});

Deno.test("US-3347: the second opinion is a DIFFERENT allowlisted model", () => {
  // Three things, and the first is the only one a value check can catch that a
  // source scan cannot.
  //
  // 1. The two are not the same model. A second opinion from the model that
  //    gave the first is not a weaker check, it is manufactured evidence: the
  //    composite runs twice, agrees with itself, and the note records that a
  //    second model confirmed the grade. second-opinion.ts refuses to FALL BACK
  //    to the primary for that reason; nothing stopped the two tiers being
  //    edited into each other until this line.
  //
  //    Widened to `string` deliberately: CURRENT_MODELS is `as const`, so while
  //    the two differ TypeScript calls the comparison unintentional (TS2367)
  //    and refuses to compile it. The day they are edited into each other the
  //    types DO overlap, the error goes away, and this assertion is the only
  //    thing left that notices.
  const secondModel: string = CURRENT_MODELS.secondOpinion;
  const primaryModel: string = CURRENT_MODELS.default;
  assert(
    secondModel !== primaryModel,
    `the second-opinion tier and the grading default are both ` +
      `${primaryModel}, so the pass would grade twice with one model and ` +
      `report agreement. Point one of them somewhere else.`,
  );

  // 2. It is on the grading allowlist, which is where a model earns the right
  //    to touch a grade. resolveSecondOpinionConfig would otherwise DISABLE the
  //    feature at runtime with a warning nobody reads until they wonder why the
  //    setting they turned on did nothing.
  assert(
    GRADING_MODEL_ALLOWLIST.has(CURRENT_MODELS.secondOpinion),
    `${CURRENT_MODELS.secondOpinion} is the second-opinion tier but is not on ` +
      `GRADING_MODEL_ALLOWLIST, so the pass refuses itself the moment it is ` +
      `enabled. A model joins that list at the eval gate.`,
  );

  // 3. second-opinion.ts still takes its default FROM the tier. The source scan
  //    catches a raw id going back in; this catches the subtler version, where
  //    the config stops reading the registry and starts reading something else
  //    that happens to be a string.
  assertEquals(
    DEFAULT_SECOND_OPINION_CONFIG.model,
    CURRENT_MODELS.secondOpinion,
    "DEFAULT_SECOND_OPINION_CONFIG.model no longer derives from the registry",
  );
});

Deno.test("US-3186: a retained id is still present everywhere it says it is", () => {
  // AC3, and the one that must never be 'simplified'. Deleting a retained id
  // does not fail anything at runtime: a missing price row prices history at
  // $0.00 and a missing grading entry just stops a regrade being comparable.
  assert(
    Object.keys(RETAINED_MODEL_IDS).length > 0,
    "RETAINED_MODEL_IDS is empty. If a previous-generation id was genuinely " +
      "retired everywhere, say so in the story note - do not empty this table " +
      "to make the test pass.",
  );

  const surfaces: Record<RetainedSurface, [string, (id: string) => boolean]> = {
    prices: [
      "ai-usage MODEL_PRICES",
      (id) => MODEL_PRICES[id] !== undefined,
    ],
    grading: [
      "ai-config GRADING_MODEL_ALLOWLIST",
      (id) => GRADING_MODEL_ALLOWLIST.has(id),
    ],
    content: [
      "ai-config CONTENT_MODEL_ALLOWLIST",
      (id) => CONTENT_MODEL_ALLOWLIST_FOR_TESTS.includes(id),
    ],
    agents: [
      "agent-kernel AGENT_MODEL_ALLOWLIST",
      (id) => AGENT_MODEL_ALLOWLIST.includes(id),
    ],
  };

  for (const [id, retained] of Object.entries(RETAINED_MODEL_IDS)) {
    assert(
      retained.reason.trim().length >= 40,
      `${id} is retained with no real reason written beside it`,
    );
    assert(retained.keepIn.length > 0, `${id} is retained but keeps nothing`);
    for (const surface of retained.keepIn) {
      const [label, present] = surfaces[surface];
      assert(
        present(id),
        `${id} was removed from ${label}. It is retained on purpose: ` +
          `${retained.reason}`,
      );
    }
  }

  // The price case named explicitly, because it is the one that reads as a win.
  // A deleted row is silent: priceFor() answers 0 for an unknown id.
  assert(
    MODEL_PRICES[MODEL_IDS.sonnet46] !== undefined,
    "the Sonnet 4.6 price row is gone, so every historical ai_usage_events row " +
      "on that model now prices at $0.00 and the bill appears to have dropped",
  );
});

Deno.test("US-3186: the lightweight prefixes are the lightweight families", () => {
  const expected = Object.entries(MODEL_FAMILIES)
    .filter(([, spec]) => spec.isLightweightTier)
    .map(([family]) => `claude-${family}`)
    .sort();

  assertEquals([...LIGHTWEIGHT_MODEL_PREFIXES].sort(), expected);
  assert(expected.length > 0, "no family is marked as the lightweight tier");

  // Behaviour, not just the list: every registry id in a lightweight family is
  // classified as lightweight, and no id outside one is.
  for (const id of KNOWN_MODEL_IDS) {
    const family = modelFamily(id);
    if (family === null) {
      assert(
        NON_ANTHROPIC_MODEL_IDS.has(id),
        `${id} is not Anthropic-shaped but is not listed as non-Anthropic`,
      );
      continue;
    }
    const spec = MODEL_FAMILIES[family];
    assert(spec !== undefined, `${id} is in family "${family}", which has no rule`);
    assertEquals(
      isLightweightModel(id),
      spec.isLightweightTier,
      `${id} is classified as ${isLightweightModel(id) ? "" : "not "}lightweight ` +
        `but its family says otherwise; a token-profile report would bucket its ` +
        `spend on the wrong side`,
    );
  }
});

Deno.test("US-3186: every registry id is well-formed and classified", () => {
  for (const id of KNOWN_MODEL_IDS) {
    assertEquals(id, id.trim().toLowerCase(), `${id} is not a normalised id`);
    if (NON_ANTHROPIC_MODEL_IDS.has(id)) continue;
    assert(
      MODEL_ID_PATTERN.test(id),
      `${id} does not match the claude-<family>-<gen> naming the rules parse`,
    );
    assert(
      classifyEffortSupport(id) !== "unknown",
      `${id} is a registry id but unclassified for output_config.effort, so ` +
        `every call routed to it silently drops the parameter`,
    );
  }

  // The registry knows the current ids AND the retained ones, and they do not
  // overlap: an id cannot be both what this build runs and what it kept.
  for (const id of CURRENT_MODEL_IDS) {
    assert(isKnownModelId(id), `${id} is current but not in KNOWN_MODEL_IDS`);
    assert(
      RETAINED_MODEL_IDS[id] === undefined,
      `${id} is listed as both current and retained`,
    );
  }
  for (const id of Object.keys(RETAINED_MODEL_IDS)) {
    assert(isKnownModelId(id), `${id} is retained but not in KNOWN_MODEL_IDS`);
  }
});

// -- SOURCE -------------------------------------------------------------------

Deno.test("US-3186: the scan's own pattern finds ids where ids live", () => {
  // The positive control. An empty result from the scan below is only evidence
  // if the scan can find an id at all; without this, deleting a character from
  // MODEL_ID_LITERAL turns the guard green forever.
  const registry = codeOnly(readModule(REGISTRY_MODULE));
  const found = new Set(modelIdLiterals(registry));

  for (const id of Object.values(MODEL_IDS)) {
    assert(
      found.has(id),
      `the scan pattern does not match ${id} in the registry's own code, so a ` +
        `raw pin elsewhere would not be matched either`,
    );
  }

  // And comment-stripping does not eat code: the registry's ids are all in
  // code, so the count above is not an artefact of the stripper being a no-op.
  assert(
    found.size >= Object.keys(MODEL_IDS).length,
    "the comment stripper removed the registry's id table",
  );
});

Deno.test("US-3347: the scanned set is the tree, and the tree is not empty", () => {
  // The control for the widening itself. A derived corpus can derive to nothing:
  // a renamed directory, a walk that never recurses, a skip list that matches
  // too much. An empty corpus reports zero findings, which is exactly what
  // a clean service reports. So: it is large, it contains the files that
  // actually default a model, and it contains neither the tests nor the
  // registry.
  assert(
    SCANNED.length >= 500,
    `the scan walked ${SCANNED.length} files. The service has over a thousand ` +
      `outside src/tests; a number this small means the walk stopped early and ` +
      `its "no raw ids found" answer is about a corpus that is not the service.`,
  );

  const paths = new Set(SCANNED.map(shortPath));
  for (const required of MUST_BE_SCANNED) {
    assert(
      paths.has(required),
      `${required} is not in the scanned set. It defaults or resolves a model, ` +
        `so a raw id planted in it would go unseen, which is precisely what ` +
        `happened to second-opinion.ts under the four-file list (US-3347).`,
    );
  }

  // The registry is the one file allowed to write ids, and it is excluded by
  // identity rather than by spelling, so a rename cannot silently re-include it
  // (which would turn the scan permanently red) or exclude a second file.
  assert(!paths.has("src/lib/ai-model-registry.ts"), "the registry is in its own corpus");
  assert(
    walkTypeScript(SERVICE_ROOT).length - SCANNED.length === 1,
    "the registry exclusion removed something other than exactly one file",
  );

  // Tests are excluded as a DIRECTORY, and the exclusion has to be excluding
  // something real: if TESTS_DIR ever stops matching, this file's own fixtures
  // land in the corpus and the suite goes loudly red rather than quietly wrong.
  assert(
    [...paths].every((p) => !p.startsWith("src/tests/")),
    "a file under src/tests is in the scanned corpus",
  );
  assert(
    [...Deno.readDirSync(TESTS_DIR)].some((e) => e.name.endsWith("_test.ts")),
    "TESTS_DIR resolves to a directory with no test files in it, so the " +
      "exclusion is pointed at the wrong place",
  );
});

Deno.test("US-3347: no file in the service pins a model id in code", () => {
  // The whole service, not a list of four. Every finding is reported, not the
  // first, because a sweep that stops at one file gets run five times.
  const offenders: string[] = [];
  for (const file of SCANNED) {
    const literals = modelIdLiterals(codeOnly(Deno.readTextFileSync(file)));
    if (literals.length > 0) {
      offenders.push(`${shortPath(file)}: ${[...new Set(literals)].join(", ")}`);
    }
  }
  assertEquals(
    offenders,
    [],
    `these files name a model id directly in code:\n  ${offenders.join("\n  ")}\n` +
      `Model ids live in src/lib/ai-model-registry.ts and every other file ` +
      `references MODEL_IDS or CURRENT_MODELS. A raw id is a place "change the ` +
      `model" has to be hunted for, and the copy left behind keeps working ` +
      `(US-3186, US-3347).`,
  );
});

Deno.test("US-3186: the registry is the only module that writes an id", () => {
  // Stated as a count rather than a spelling, so extracting a helper out of one
  // of these files does not read as a regression: what must hold is that the
  // ids are in ONE file, not that they are on a particular line of it.
  const registryIds = new Set(modelIdLiterals(codeOnly(readModule(REGISTRY_MODULE))));
  assert(
    registryIds.size >= new Set(Object.values(MODEL_IDS)).size,
    "the registry writes fewer ids than MODEL_IDS holds",
  );
});
