// US-1900: listing_gen_v2 prompt v-next regression.
//
// Two guarantees, both AI-free (pure text + the publish-gate lint):
//   1. The v2 system prompt actually ENCODES the verified policy/AI-summary
//      rules (cross-brand-comparison ban, no-duplicate-token, prefer
//      buyer-typed qualifiers, condition/tier consistency, measurements
//      preserved, "eBay AI-summarizes descriptions" guidance).
//   2. The policy-phrase case holds end-to-end: a tempting "fits like <brand>"
//      title is BLOCKED by the shared publish lint (title-lint.ts, US-1890) —
//      the ban the v2 prompt instructs the model to obey is enforced at the
//      gate, so a slip still can't publish.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { lintTitle } from "../lib/title-lint.ts";

// ai-listing.ts -> supabase.ts throws at import without env. Dummy-env then
// dynamic-import (mirrors listing-acceptance_test.ts).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  LISTING_GEN_PROMPT_VERSION,
  LISTING_GEN_PROMPT_VERSION_V2,
  LISTING_GEN_SYSTEM_PROMPT,
  LISTING_GEN_SYSTEM_PROMPT_V2,
  resolvePromptText,
} = await import("../lib/ai-listing.ts");

Deno.test("v2 version name is listing_gen_v2", () => {
  assertEquals(LISTING_GEN_PROMPT_VERSION_V2, "listing_gen_v2");
});

Deno.test("v2 prompt bans cross-brand comparison in the title", () => {
  const p = LISTING_GEN_SYSTEM_PROMPT_V2;
  assertStringIncludes(p, "NEVER compare to another brand");
  assertStringIncludes(p, "search-manipulation");
  // The exact tempting phrases the ban must name (line-wrap-insensitive).
  const flat = p.replace(/\s+/g, " ");
  assertStringIncludes(flat, "fits like <brand>");
  assertStringIncludes(flat, "style of <brand>");
  assertStringIncludes(flat, "similar to <brand>");
});

Deno.test("v2 prompt forbids duplicate title tokens and prefers buyer-typed qualifiers", () => {
  const p = LISTING_GEN_SYSTEM_PROMPT_V2;
  assertStringIncludes(p, "NEVER repeat a word/token within the title");
  assertStringIncludes(p, "PREFER buyer-typed qualifiers");
});

Deno.test("v2 prompt carries AI-summary-era description + tier/measurement guidance", () => {
  const p = LISTING_GEN_SYSTEM_PROMPT_V2;
  assertStringIncludes(p, "AI-SUMMARIZES");
  assertStringIncludes(p, "MEASUREMENTS");
  assertStringIncludes(p, "CONSISTENT with the chosen");
  // No-keyword-list guidance.
  assertStringIncludes(p, "never dump a");
});

Deno.test("policy-phrase case: a tempting 'fits like <brand>' title is BLOCKED at the publish gate", () => {
  // A tempting item: generic leggings a seller wants to ride Lululemon's search.
  const tempting = "High-Waist Leggings fits like Lululemon Align Buttery Soft L";
  const res = lintTitle(tempting);
  assertEquals(res.policyViolations.length > 0, true);
  assertStringIncludes(res.policyViolations[0], "search-manipulation");
});

Deno.test("policy-phrase case: benign fit phrasing is NOT blocked (no false positive)", () => {
  // The v2 prompt explicitly carves out benign fit phrasing; the gate agrees.
  const ok = lintTitle("Levi's 501 Jeans fits like a glove Straight Leg W32 L30");
  assertEquals(ok.policyViolations.length, 0);
});

// ---------------------------------------------------------------------------
// US-2674 AC5: the empty-text row resolves to the V2 CODE PROMPT
//
// Migration 00446 seeds listing_gen_v2 with prompt_text = '' on purpose, so the
// prompt text lives in code and is reviewed as code. Everything downstream then
// depends on one lookup: version_name -> code constant.
//
// Get that lookup wrong and the failure is silent in the worst possible way.
// The row is active, ai_prompt_versions says listing_gen_v2, every acceptance
// row and eval result is STAMPED listing_gen_v2 -- and the model is being sent
// v1. The canary then compares v1 against v1, finds no regression (correctly),
// and promotes a champion that never changed. Nothing anywhere reads red.
// ---------------------------------------------------------------------------

Deno.test("an empty-text listing_gen_v2 row resolves to the V2 prompt, not v1", () => {
  assertEquals(resolvePromptText("", LISTING_GEN_PROMPT_VERSION_V2), LISTING_GEN_SYSTEM_PROMPT_V2);
});

Deno.test("a NULL-text listing_gen_v2 row resolves the same way", () => {
  // The column is nullable and 00446 writes '', but a hand-inserted row can be
  // NULL and must not fall through to v1.
  assertEquals(
    resolvePromptText(null, LISTING_GEN_PROMPT_VERSION_V2),
    LISTING_GEN_SYSTEM_PROMPT_V2,
  );
});

Deno.test("whitespace is not prompt text, so it still resolves from code", () => {
  assertEquals(
    resolvePromptText("   \n\t ", LISTING_GEN_PROMPT_VERSION_V2),
    LISTING_GEN_SYSTEM_PROMPT_V2,
  );
});

Deno.test("v1 and v2 are genuinely DIFFERENT text, or the test above proves nothing", () => {
  // The assertion the other cases lean on. If someone points both names at one
  // constant, every case here passes while the rollout measures nothing.
  //
  // String() widens away the literal types on purpose: tsc narrows these two
  // constants to their exact contents and rejects the comparison as provably
  // never-equal, which is a stronger guarantee than this test -- but a compiler
  // error is not a test, and it disappears the moment either side stops being a
  // literal.
  assertEquals(
    String(LISTING_GEN_SYSTEM_PROMPT) === String(LISTING_GEN_SYSTEM_PROMPT_V2),
    false,
    "listing_gen_v1 and listing_gen_v2 resolve to identical text",
  );
});

Deno.test("an empty-text listing_gen_v1 row still resolves to the v1 prompt", () => {
  assertEquals(resolvePromptText("", LISTING_GEN_PROMPT_VERSION), LISTING_GEN_SYSTEM_PROMPT);
});

Deno.test("a DB-authored prompt_text wins over the code registry", () => {
  // The override path: a row that carries real text is used verbatim, so an
  // operator can serve a prompt that has no code constant at all.
  const authored = "A fully DB-authored listing prompt.";
  assertEquals(resolvePromptText(authored, LISTING_GEN_PROMPT_VERSION_V2), authored);
});

Deno.test("an unknown version_name falls back to v1, the known-good champion", () => {
  // AC2's safety half. A typo'd or legacy version_name must not serve an empty
  // prompt or throw -- it serves the champion, which is the conservative answer.
  assertEquals(resolvePromptText("", "listing_gen_v9_typo"), LISTING_GEN_SYSTEM_PROMPT);
});

Deno.test("the code DEFAULT is still v1: activation is a database act, not an edit", () => {
  // AC2. The only supported way v2 becomes champion is activatePromptVersion
  // flipping the ai_prompt_versions row. If this constant is ever edited to
  // "listing_gen_v2" the prompt has been hot-swapped past the eval gate, the
  // canary and the acceptance comparison the whole story exists to require.
  assertEquals(LISTING_GEN_PROMPT_VERSION, "listing_gen_v1");
});
