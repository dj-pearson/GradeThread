// US-3211 AC4: the voice a new account starts on.

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_LISTING_VOICE_PRESET,
  FLUFF_WORDS,
  fluffWordsIn,
  PLAIN_FACTS_PROMPT,
  presetFor,
  resolveVoicePrompt,
  STANDARD_SENTINEL,
} from "../lib/listing-voice-presets.ts";

Deno.test("US-3211 AC4: a brand-new account starts on Plain facts", () => {
  assertEquals(DEFAULT_LISTING_VOICE_PRESET, "plain_facts");
  assertEquals(resolveVoicePrompt(null), PLAIN_FACTS_PROMPT);
  assertEquals(resolveVoicePrompt(""), PLAIN_FACTS_PROMPT);
  assertEquals(resolveVoicePrompt("   "), PLAIN_FACTS_PROMPT);
  assertEquals(presetFor(null), "plain_facts");
});

Deno.test("US-3211 AC4: the old register is still reachable, deliberately", () => {
  // Without this, US-3201's promise that an empty box is byte-identical to
  // the pre-feature generator would simply be gone.
  assertEquals(resolveVoicePrompt(STANDARD_SENTINEL), null);
  assertEquals(presetFor(STANDARD_SENTINEL), "standard");
});

Deno.test("US-3211 AC4: a seller's own words still win", () => {
  assertEquals(resolveVoicePrompt("Write like a skater."), "Write like a skater.");
  assertEquals(presetFor("Write like a skater."), "custom");
});

Deno.test("US-3211 AC4: the twelve are the twelve, by name", () => {
  // ⚠ THIS USED TO ASSERT "the prompt names every fluff word", WHICH CANNOT
  // FAIL. The prompt is built from FLUFF_WORDS.join(", "), so the two are in
  // sync by construction and a sabotage renaming an entry left the test
  // green. What is worth pinning is the CONTENT: AC4 names elegant, stunning
  // and timeless, and the list is twelve words a buyer cannot check.
  assertEquals(FLUFF_WORDS.length, 12);
  for (const named of ["elegant", "stunning", "timeless"]) {
    assert(FLUFF_WORDS.includes(named), `AC4 names "${named}" and the list does not`);
  }
  assertEquals([...FLUFF_WORDS].sort(), [
    "amazing", "coveted", "elegant", "exquisite", "flawless", "gorgeous",
    "iconic", "luxurious", "must-have", "perfect", "stunning", "timeless",
  ]);
  // And the prompt really is built from it, which is what makes the above
  // enough on its own.
  assert(PLAIN_FACTS_PROMPT.includes(FLUFF_WORDS.join(", ")));
});

Deno.test("US-3211 AC4: the prompt forbids guessing a fact", () => {
  // The other half of the story: the grounding check removes an invented
  // fibre after the fact, and this asks the model not to write one.
  const p = PLAIN_FACTS_PROMPT.toLowerCase();
  for (const token of ["fibre content", "size", "era", "country of origin"]) {
    assert(p.includes(token), `the prompt does not warn against guessing ${token}`);
  }
});

Deno.test("US-3211 AC4: the golden intro carries none of the twelve", () => {
  // A FIXTURE intro rather than a live generation. A golden test over a real
  // model call is real AI spend and the owner's decision; what this holds is
  // the check itself, so the day somebody runs that generation the assertion
  // is already written and already proved to fire.
  const golden =
    "Carhartt Detroit jacket in brown duck canvas. Blanket-lined body, " +
    "corduroy collar. Chest measures 23 inches flat, length 28 inches. " +
    "Fraying at both cuffs and a paint mark on the left sleeve.";
  assertEquals(fluffWordsIn(golden), []);
});

Deno.test("US-3211 AC4: and the check actually fires", () => {
  // The assertion above passes trivially against a broken fluffWordsIn, which
  // is how a golden test becomes decoration.
  for (const word of FLUFF_WORDS) {
    assertEquals(
      fluffWordsIn(`This is a ${word} piece.`),
      [word],
      `fluffWordsIn missed "${word}"`,
    );
  }
  // And does not fire on a word that merely contains one.
  assertEquals(fluffWordsIn("The seams are imperfect in places."), []);
});
