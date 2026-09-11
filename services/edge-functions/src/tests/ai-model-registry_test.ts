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
//   SOURCE  no raw model-id literal reappears in code in the four derived
//           modules. This is the only half that can catch a NEW pin, because a
//           new pin with a plausible id would pass every value check.
//
// The source scan carries a positive control (it must find ids in the registry
// itself) so it cannot pass by matching nothing, and it excludes this file, so
// the ids quoted in the assertions below are not its own input.

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

// The four modules that derive from the registry. Paths are relative to this
// file, and each is read as text for the source half.
const DERIVED_MODULES = [
  "../lib/ai-config.ts",
  "../lib/ai-usage.ts",
  "../lib/ai-token-profile.ts",
  "../lib/agent-kernel.ts",
] as const;

const REGISTRY_MODULE = "../lib/ai-model-registry.ts";

function readModule(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, import.meta.url));
}

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

Deno.test("US-3186: no derived module pins a model id in code", () => {
  for (const rel of DERIVED_MODULES) {
    const literals = modelIdLiterals(codeOnly(readModule(rel)));
    assertEquals(
      literals,
      [],
      `${rel} names ${literals.join(", ")} directly in code. Model ids live in ` +
        `lib/ai-model-registry.ts and every other module references MODEL_IDS ` +
        `or CURRENT_MODELS. A raw id here is a place "change the model" has to ` +
        `be hunted for, and the copy left behind keeps working (US-3186).`,
    );
  }
});

Deno.test("US-3186: the registry is the only module that writes an id", () => {
  // Stated as a count rather than a spelling, so extracting a helper out of one
  // of these files does not read as a regression: what must hold is that the
  // ids are in ONE file, not that they are on a particular line of it.
  const registryIds = new Set(modelIdLiterals(codeOnly(readModule(REGISTRY_MODULE))));
  const derivedIds = new Set(
    DERIVED_MODULES.flatMap((rel) => modelIdLiterals(codeOnly(readModule(rel)))),
  );
  assertEquals(derivedIds.size, 0);
  assertEquals(
    registryIds.size >= new Set(Object.values(MODEL_IDS)).size,
    true,
  );
});
