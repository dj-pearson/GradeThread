// US-2667: the crisis path for the support assistant.
//
// Two halves are tested here. The DETECTOR, where the negative cases matter as
// much as the positive ones - this product's users type "kill this listing" and
// "my sales are dying" in ordinary support messages, and a detector that fires
// on those would be turned off within a week, which is the same outcome as not
// having one. And the REPLY, which is a constant precisely so it can be pinned:
// the numbers in it are the whole point of the feature.
//
// The route wiring (escalate with trigger 'crisis', no metering, never the
// model) is covered in support-crisis-route_test.ts.

// US-2379: first import, always - this file's graph reaches lib/supabase.ts
// through support-assistant-engine.ts, and _env.ts has to be loaded before it.
import "./_env.ts";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CRISIS_ESCALATION_REASON,
  CRISIS_ESCALATION_SUMMARY,
  CRISIS_RESPONSE,
  detectCrisis,
  normalizeForCrisis,
} from "../lib/support-crisis.ts";
import { GUARD_REFUSAL } from "../lib/support-assistant-engine.ts";

// ── The detector: messages that MUST take the crisis path ────────────────────

const CRISIS_MESSAGES: readonly string[] = [
  "i want to kill myself",
  "I've been thinking about suicide",
  "I feel suicidal and I don't know who to tell",
  "im going to hurt myself tonight",
  "I have been cutting myself again",
  "I want to end my life",
  "thinking about taking my own life",
  "I just want to die",
  "i wanna die",
  "I don't want to live anymore",
  "I don't want to be here any more",
  "there's no reason to live",
  "everyone would be better off without me",
  "I'm going to end it all",
  "my life is not worth living",
  "I'm gonna overdose",
  "I'm going to take all my pills",
  "self-harm is the only thing that helps",
  "I might hang myself",
];

for (const message of CRISIS_MESSAGES) {
  Deno.test(`detect: crisis - ${JSON.stringify(message)}`, () => {
    const r = detectCrisis(message);
    assertEquals(r.crisis, true, `should have matched: ${message}`);
    assert(r.pattern, "a matched crisis result carries the pattern source");
  });
}

// ── The detector: this product's own vocabulary must NOT trip it ─────────────
//
// Every one of these is a sentence a reseller plausibly types into support.
// They are the reason the patterns require "myself" rather than a bare verb.

const BENIGN_MESSAGES: readonly string[] = [
  "how do I kill this listing?",
  "this reconciliation is killing me",
  "I'd kill for a bulk delete button",
  "my sales are dying since the eBay update",
  "this dead stock has been sitting for a year",
  "the sync just died halfway through",
  "I'm dead serious, the grade is wrong",
  "killing it this month, 40 sales",
  "I had to cut myself off from sourcing this month",
  "can I end my subscription?",
  "how do I end my trial early",
  "the app is a lifesaver",
  "my listing died in search",
];

for (const message of BENIGN_MESSAGES) {
  Deno.test(`detect: NOT crisis - ${JSON.stringify(message)}`, () => {
    assertEquals(
      detectCrisis(message).crisis,
      false,
      `false positive on: ${message}`,
    );
  });
}

Deno.test("detect: empty and whitespace-only messages are not a crisis", () => {
  assertEquals(detectCrisis("").crisis, false);
  assertEquals(detectCrisis("   \n\t ").crisis, false);
  assertEquals(detectCrisis("!!!???").crisis, false);
});

// ── Normalization: the shapes a real keyboard produces ───────────────────────

Deno.test("detect: punctuation and spacing between the words don't hide it", () => {
  for (
    const variant of [
      "kill-myself",
      "kill.myself",
      "KILL   MYSELF",
      "...i want to kill, myself.",
    ]
  ) {
    assertEquals(detectCrisis(variant).crisis, true, variant);
  }
});

Deno.test("detect: a phone keyboard's curly apostrophe still matches", () => {
  // The straight-quote spelling and the curly one must behave identically -
  // this is the one place non-ASCII is load-bearing in support-crisis.ts.
  assertEquals(detectCrisis("I don't want to live").crisis, true);
  assertEquals(detectCrisis("I don’t want to live").crisis, true);
});

Deno.test("normalize: folds case and non-letters, keeps the apostrophe", () => {
  assertEquals(normalizeForCrisis("Don't  KILL-myself!!"), "don't kill myself");
  assertEquals(normalizeForCrisis("a1b2c3"), "a b c");
});

Deno.test("detect: a benign override does not swallow a real signal beside it", () => {
  // The override deletes the benign phrase rather than short-circuiting the
  // message. If it returned early on the first clause, this would be missed.
  const message =
    "I cut myself off from sourcing this month and honestly I want to die";
  assertEquals(detectCrisis(message).crisis, true);
});

// ── The reply ────────────────────────────────────────────────────────────────

Deno.test("response: carries every crisis resource, verbatim", () => {
  // These four strings ARE the feature. A refactor that drops one of them is
  // the failure this test exists to catch.
  assertStringIncludes(CRISIS_RESPONSE, "988");
  assertStringIncludes(CRISIS_RESPONSE, "741741");
  assertStringIncludes(CRISIS_RESPONSE, "findahelpline.com");
  assertStringIncludes(CRISIS_RESPONSE, "emergency number");
});

Deno.test("response: says plainly that it is automated", () => {
  // Honesty about being a bot is part of the reply, not decoration: the person
  // needs to know they are not already talking to someone.
  assertStringIncludes(CRISIS_RESPONSE, "automated assistant");
});

Deno.test("response: is not a scope refusal", () => {
  const lowered = CRISIS_RESPONSE.toLowerCase();
  for (const forbidden of ["out of scope", "i can't help with", "can only help"]) {
    assert(
      !lowered.includes(forbidden),
      `crisis reply must not read as a refusal (found: ${forbidden})`,
    );
  }
  assert(CRISIS_RESPONSE !== GUARD_REFUSAL);
});

Deno.test("escalation copy: never quotes the user's own words", () => {
  // The reason string travels into a notification body, an email and a list
  // view. It describes WHY the thread is urgent and nothing else - the message
  // itself stays in the conversation, which is one click away.
  assertStringIncludes(CRISIS_ESCALATION_REASON, "crisis");
  assert(CRISIS_ESCALATION_REASON.length < 200);
  assertStringIncludes(CRISIS_ESCALATION_SUMMARY, "crisis resources");
});
