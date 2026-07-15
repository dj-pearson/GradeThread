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

const { LISTING_GEN_SYSTEM_PROMPT_V2, LISTING_GEN_PROMPT_VERSION_V2 } = await import(
  "../lib/ai-listing.ts"
);

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
