// US-3211 AC4: the voice presets, web mirror.
//
// services/edge-functions/src/lib/listing-voice-presets.ts is authoritative --
// it is what the generator reads. This copy exists so the settings screen can
// name the presets and show which one a stored value represents without a
// round trip. src/test/listing-voice-parity.test.ts fails if the two drift.

export const LISTING_VOICE_PRESETS = ["plain_facts", "standard", "custom"] as const;
export type ListingVoicePreset = (typeof LISTING_VOICE_PRESETS)[number];

/** What a brand-new account starts on. */
export const DEFAULT_LISTING_VOICE_PRESET: ListingVoicePreset = "plain_facts";

/** The sentinel a seller stores to get the pre-US-3201 register back. */
export const STANDARD_SENTINEL = "__standard__";

export const LISTING_VOICE_PRESET_LABELS: Record<ListingVoicePreset, string> = {
  plain_facts: "Plain facts",
  standard: "Standard",
  custom: "Your own words",
};

export const LISTING_VOICE_PRESET_BLURBS: Record<ListingVoicePreset, string> = {
  plain_facts:
    "What it is, what it's made of, how it fits, what's wrong with it. " +
    "No sales words.",
  standard: "The wording descriptions used before presets existed.",
  custom: "Tell the writer how you want to sound.",
};

/** Which preset a stored value represents. Mirrors the server, exactly. */
export function presetFor(stored: string | null | undefined): ListingVoicePreset {
  const text = (stored ?? "").trim();
  if (text === STANDARD_SENTINEL) return "standard";
  if (text === "") return "plain_facts";
  return "custom";
}
