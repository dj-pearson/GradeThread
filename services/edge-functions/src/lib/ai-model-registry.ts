// The one place a model id is written down (US-3186).
//
// WHAT THIS EXISTS FOR. A model id used to be decided in twelve places, so
// "change the model" was a hunt rather than an edit, and a copy left behind
// kept routing, pricing or reporting against a model nobody ran. The twelve,
// classified by what a wrong value there actually costs:
//
//   ROUTES traffic  -- a wrong id sends real calls to the wrong model
//     1. CURRENT_MODELS below, read by ai-config.ts DEFAULTS
//     2. GRADING_MODEL_ALLOWLIST      (ai-config.ts)
//     3. CONTENT_MODEL_ALLOWLIST      (ai-config.ts)
//     4. AGENT_MODEL_ALLOWLIST        (agent-kernel.ts)
//     5. system_settings.grading_model_cascade      (model-routing.ts)
//     6. system_settings.ai_action_model_cascade    (ai-action-cascade.ts)
//     7. the Coolify TEAM variables themselves (DEFAULT_AI_MODEL and friends)
//
//   PRICES history  -- a wrong or MISSING id reprices rows that already exist
//     8. MODEL_PRICES                 (ai-usage.ts)
//     9. system_settings.ai_model_prices (the ai_profitability RPC's copy)
//
//   DESCRIBES state -- a wrong id makes a report lie without changing a call
//    10. CURRENT_MODEL_IDS below, the resolver's "is this id expected" set
//    11. LIGHTWEIGHT_MODEL_PREFIXES   (ai-token-profile.ts)
//    12. system_settings.ai_feature_economics.*.current_model
//
// Items 5, 6, 9 and 12 live in the database and cannot be derived from here.
// vault/10-ops/ai-model-change.md says what a code change does and does not
// reach, and carries the SQL for the four DB rows.
//
// THE RULE FOR ADDING ANYTHING HERE. Ids go in this file; everything else names
// a constant from it. src/tests/ai-model-registry_test.ts fails if one of the
// derived surfaces names an id this file does not know, and fails if a raw
// model-id literal reappears in code in any of the four derived modules.
//
// PURE ON PURPOSE. No Deno, no imports. ai-config.ts, ai-usage.ts,
// ai-token-profile.ts and agent-kernel.ts all import this, so anything it
// imported back would be a cycle.

// -- The ids ------------------------------------------------------------------
//
// Written once, referenced by name everywhere else. A name rather than a bare
// string so a stale pin reads as `MODEL_IDS.sonnet46` at its use site, which is
// legible in a diff in a way that a fifth copy of a hyphenated string is not.
export const MODEL_IDS = {
  opus5: "claude-opus-5",
  opus48: "claude-opus-4-8",
  sonnet5: "claude-sonnet-5",
  sonnet46: "claude-sonnet-4-6",
  /** Bare alias; the same model as haiku45Dated, accepted by the API. */
  haiku45: "claude-haiku-4-5",
  haiku45Dated: "claude-haiku-4-5-20251001",
  /**
   * Image generation runs through OpenAI's images API; the Anthropic models do
   * not render images. Here so the image model is a shared-config value and
   * never a string at the call site (US-853).
   */
  imageGpt1: "gpt-image-1",
} as const;

export type ModelIdKey = keyof typeof MODEL_IDS;

/** Ids that are not Anthropic models, so the family rules below never apply. */
export const NON_ANTHROPIC_MODEL_IDS: ReadonlySet<string> = new Set([
  MODEL_IDS.imageGpt1,
]);

// -- What each tier runs on TODAY ---------------------------------------------
//
// THE ONE EDIT. Changing a tier's model is changing a line here; ai-config.ts
// DEFAULTS is these three values and nothing else. It does not reach the
// allowlists, the price table or the four system_settings rows, and it is not
// meant to: see the "what it does not reach" section of the ops doc.
export const CURRENT_MODELS = {
  /** Vision, grading, composite synthesis, and anything unclassified. */
  default: MODEL_IDS.sonnet5,
  /** Text-only enrichment: the cheap tier. */
  lightweight: MODEL_IDS.haiku45Dated,
  /** Hero and social-card image generation. */
  image: MODEL_IDS.imageGpt1,
} as const;

export type ModelTierName = keyof typeof CURRENT_MODELS;

/**
 * Ids this generation of the code expects a model variable to be pointed at.
 *
 * Wider than CURRENT_MODELS because an operator can legitimately pin a tier to
 * a sibling of the same generation. resolveModelVar() warns on anything outside
 * this set and HONOURS it anyway, because a model newer than the build is
 * legitimate and refusing it would make every model launch a code change.
 */
export const CURRENT_MODEL_IDS: ReadonlySet<string> = new Set([
  MODEL_IDS.opus5,
  MODEL_IDS.opus48,
  CURRENT_MODELS.default,
  MODEL_IDS.haiku45,
  CURRENT_MODELS.lightweight,
]);

// -- Ids kept on purpose, with the reason attached ----------------------------
//
// READ THIS BEFORE DELETING ONE. Every id below is previous-generation and
// every one of them still has to appear in the surfaces its `keepIn` lists.
// The failure is not symmetric:
//
//   Deleting a PRICE row does not raise an error. priceFor() returns 0 for an
//   unknown id, so every historical ai_usage_events row on that model reprices
//   to $0.00 and the bill appears to have dropped. That reads as a cost win and
//   is a data loss.
//
//   Deleting a GRADING allowlist entry means a submission graded on that model
//   can no longer be re-graded on it, so the certificate and the regrade stop
//   being comparable.
//
// src/tests/ai-model-registry_test.ts asserts each keepIn membership, so a
// deletion is a red test rather than a quiet reprice.
export type RetainedSurface = "prices" | "grading" | "content" | "agents";

export interface RetainedModel {
  /** Why this id may not be deleted. One sentence, at the deletion site. */
  reason: string;
  /** The surfaces that must keep naming it. */
  keepIn: readonly RetainedSurface[];
}

export const RETAINED_MODEL_IDS: Readonly<Record<string, RetainedModel>> = {
  [MODEL_IDS.sonnet46]: {
    reason:
      "The default before 2026-07-02. Grading keeps it so a submission stays " +
      "re-gradable on the model that produced it; the price table keeps it so " +
      "historical ai_usage_events rows (including the 169 tag_ocr calls of " +
      "2026-09-02, US-3184) price at what they were billed rather than $0.",
    keepIn: ["prices", "grading", "content", "agents"],
  },
};

/** Every id this build knows about at all: current, retained, non-Anthropic. */
export const KNOWN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...Object.values(MODEL_IDS),
  ...Object.keys(RETAINED_MODEL_IDS),
]);

export function isKnownModelId(model: string): boolean {
  return KNOWN_MODEL_IDS.has(model.trim());
}

// -- Families: effort support, and which family IS the cheap tier -------------
//
// Moved here from ai-config.ts by US-3186 so the id table and the rules that
// read ids sit together. The rule itself is US-3305's and unchanged.
//
// A RULE, NOT A PREFIX LIST. The effort answer used to be six startsWith()
// calls, and claude-opus-5 was not one of them. Opus 5 takes effort low..max,
// so any variable pointed at it fed the params builder a model classified as
// effort-free, and every call went out with NO effort at the model's own
// default. The call succeeds. Nothing logs. A dropped parameter looks exactly
// like a parameter nobody set, which is why it survived a release.
//
// A list has to be edited for every new id and the edit is invisible when it is
// forgotten. The naming already carries the answer, so the rule reads it:
// within a family, effort arrived at a known generation and every later
// generation keeps it. It answers "yes" for claude-opus-5-1, claude-opus-6 and
// claude-sonnet-6 with nobody touching this file.
//
// Where it CANNOT know -- a family this build has never seen, or a Haiku newer
// than any that has been checked -- it says "unknown" rather than quietly
// answering "no". modelUsesEffort() logs that case loudly and still returns
// false, because the two errors are not priced the same: a wrong "yes" 400s
// every call for that feature, a wrong "no" only costs the setting.
//
// Thresholds, from the Anthropic model documentation (read 2026-09-10):
//   opus    effort from 4.5 (4.5 is low/medium/high only; 4.6+ add xhigh/max)
//   sonnet  effort from 4.6; Sonnet 4.5 and older reject it
//   haiku   no released Haiku accepts it; 4.5 returns an error
//   fable   every released generation (5.0+), thinking is always on
//   mythos  same surface as fable
//
// `isLightweightTier` is the second thing a family decides, and it is the same
// kind of fact: the Haiku family IS the cheap tier, which is why the token
// profile can classify a ledger row's model without a list of ids to maintain.
export type EffortSupport = "yes" | "no" | "unknown";

export interface ModelFamilySpec {
  /** First [major, minor] in this family that accepts effort, or null if none does yet. */
  takesEffortFrom: readonly [number, number] | null;
  /** Newest [major, minor] this build has actually checked. Only consulted when the above is null. */
  classifiedThrough: readonly [number, number];
  /** True when every id in this family is the lightweight (cheap) tier. */
  isLightweightTier: boolean;
}

export const MODEL_FAMILIES: Readonly<Record<string, ModelFamilySpec>> = {
  opus: {
    takesEffortFrom: [4, 5],
    classifiedThrough: [5, 0],
    isLightweightTier: false,
  },
  sonnet: {
    takesEffortFrom: [4, 6],
    classifiedThrough: [5, 0],
    isLightweightTier: false,
  },
  haiku: {
    takesEffortFrom: null,
    classifiedThrough: [4, 5],
    isLightweightTier: true,
  },
  fable: {
    takesEffortFrom: [5, 0],
    classifiedThrough: [5, 1],
    isLightweightTier: false,
  },
  mythos: {
    takesEffortFrom: [5, 0],
    classifiedThrough: [5, 1],
    isLightweightTier: false,
  },
};

/** claude-<family>-<major>[-<minor>][-<datestamp>]: the naming since Claude 4.5. */
export const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/;

/** Pre-4.5 naming, which puts the generation BEFORE the family. */
const LEGACY_MODEL_ID_PATTERN = /^claude-\d/;

function atLeast(
  v: readonly [number, number],
  min: readonly [number, number],
): boolean {
  return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);
}

/** The family segment of a model id, or null when the id is not Anthropic-shaped. */
export function modelFamily(model: string): string | null {
  const m = MODEL_ID_PATTERN.exec(model.trim().toLowerCase());
  return m ? (m[1] ?? null) : null;
}

/**
 * Does this model accept output_config.effort: yes, no, or not knowable here?
 *
 * Exported so a test can assert the third answer exists at all: "unknown"
 * collapsing into "no" is precisely the failure US-3305 was about.
 */
export function classifyEffortSupport(model: string): EffortSupport {
  const id = model.trim().toLowerCase();

  // Pre-4.5 ids (claude-3-5-sonnet-..., claude-2-1). None of them accept effort
  // and none ever will: the naming itself dates them, so this is a rule and not
  // a list of legacy ids.
  if (LEGACY_MODEL_ID_PATTERN.test(id)) return "no";

  const m = MODEL_ID_PATTERN.exec(id);
  if (!m) return "unknown";
  const rule = MODEL_FAMILIES[m[1] ?? ""];
  if (!rule) return "unknown";

  const version: [number, number] = [Number(m[2]), Number(m[3] ?? 0)];
  if (rule.takesEffortFrom) {
    return atLeast(version, rule.takesEffortFrom) ? "yes" : "no";
  }
  // No generation of this family takes effort yet. Anything at or below what
  // was actually checked is a confident no; anything newer is a guess.
  return atLeast(version, [
    rule.classifiedThrough[0],
    rule.classifiedThrough[1] + 1,
  ])
    ? "unknown"
    : "no";
}

/**
 * Id prefixes that ARE the lightweight tier, derived from the family table.
 *
 * Prefix-matched rather than id-matched because the ledger holds whatever the
 * API was sent, datestamp and all, and a report that only recognises the exact
 * ids in MODEL_IDS would silently reclassify a row the day a new Haiku ships.
 */
export const LIGHTWEIGHT_MODEL_PREFIXES: readonly string[] = Object.entries(
  MODEL_FAMILIES,
)
  .filter(([, spec]) => spec.isLightweightTier)
  .map(([family]) => `claude-${family}`);

export function isLightweightModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return LIGHTWEIGHT_MODEL_PREFIXES.some((p) => m.startsWith(p));
}
