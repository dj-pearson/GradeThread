// US-3211 AC4: the voice a new account starts with, and the words it forbids.
//
// ── WHY THERE IS A DEFAULT AT ALL ───────────────────────────────────────────
// US-3201 made the voice a free-text box and left it empty, which meant every
// new seller got the generator's own register: the one buyers on r/Ebay say
// they scroll past and treat as grounds for a return (three threads, 900+
// combined upvotes, quoted in
// vault/50-business/competitors/forum-sentiment.md section 8). An empty box is
// not neutral when the fallback is the thing people complain about.
//
// ── PLAIN FACTS IS A PRESET, NOT A LOCK ─────────────────────────────────────
// A seller who wants the old register picks Standard and gets exactly what
// they had; a seller who wants their own still types it. What changes is only
// which of the three a brand-new account starts on.
//
// ── THE FLUFF LIST IS TWELVE WORDS AND THAT IS ON PURPOSE ───────────────────
// Every one is an adjective a buyer cannot check against a photo. A longer
// list starts catching words that carry real information ("cropped",
// "oversized"), and the moment it does, sellers turn the preset off.

export const LISTING_VOICE_PRESETS = ["plain_facts", "standard", "custom"] as const;
export type ListingVoicePreset = (typeof LISTING_VOICE_PRESETS)[number];

/** What a brand-new account starts on (AC4). */
export const DEFAULT_LISTING_VOICE_PRESET: ListingVoicePreset = "plain_facts";

/**
 * Adjectives that assert nothing a buyer can verify.
 *
 * Asserted one by one in listing-voice-presets_test.ts, so a word cannot be
 * dropped from the prompt while staying in the list or the other way round.
 */
export const FLUFF_WORDS: readonly string[] = [
  "stunning",
  "elegant",
  "timeless",
  "gorgeous",
  "flawless",
  "luxurious",
  "exquisite",
  "iconic",
  "coveted",
  "must-have",
  "perfect",
  "amazing",
];

/**
 * The Plain facts prompt.
 *
 * It travels through voicePromptBlock like any seller-typed voice, which is
 * what keeps it subordinate to the schema and the facts: a preset is a
 * preference, not a second contract.
 */
export const PLAIN_FACTS_PROMPT = [
  "Write like a careful seller listing their own garment. State what the item",
  "is, what it is made of when the tag says, how it fits, and what is wrong",
  "with it. Short sentences. No sales language.",
  "",
  `Never use these words: ${FLUFF_WORDS.join(", ")}.`,
  "",
  "No superlatives, and no adjective a buyer cannot check against a photo.",
  "Do not guess at fibre content, size, era or country of origin. If a fact is",
  "not in front of you, leave it out rather than reaching for a likely one.",
].join("\n");

export const LISTING_VOICE_PRESET_LABELS: Record<ListingVoicePreset, string> = {
  plain_facts: "Plain facts",
  standard: "Standard",
  custom: "Your own words",
};

/**
 * The prompt for a stored voice value.
 *
 * ⚠ NULL IS NOT "OFF" ANY MORE, and that is the behaviour change AC4 asks
 * for. A row that has never been touched resolves to Plain facts. The escape
 * hatch is STANDARD_SENTINEL, which a seller selects deliberately and which
 * resolves to null -- byte-identical to the pre-US-3201 generator.
 */
export const STANDARD_SENTINEL = "__standard__";

export function resolveVoicePrompt(stored: string | null | undefined): string | null {
  const text = (stored ?? "").trim();
  if (text === STANDARD_SENTINEL) return null;
  if (text === "") return PLAIN_FACTS_PROMPT;
  return text;
}

/** Which preset a stored value represents, for the settings screen. */
export function presetFor(stored: string | null | undefined): ListingVoicePreset {
  const text = (stored ?? "").trim();
  if (text === STANDARD_SENTINEL) return "standard";
  if (text === "") return "plain_facts";
  return "custom";
}

/** The fluff words present in a piece of prose, lowercased and deduped. */
export function fluffWordsIn(text: string): string[] {
  const hay = (text ?? "").toLowerCase();
  const found = new Set<string>();
  for (const word of FLUFF_WORDS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9]|$)`, "i").test(hay)) {
      found.add(word);
    }
  }
  return [...found];
}
