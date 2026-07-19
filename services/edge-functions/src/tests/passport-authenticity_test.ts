// US-2142: what gets written to the passport ledger, and what deliberately
// doesn't. Pure payload logic — no supabase load.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { buildAuthenticityEventPayload } = await import("../lib/passport-authenticity.ts");

const ASSESSED = {
  assessed: true,
  authenticity_confidence: 0.8,
  counterfeit_risk: "low",
  verdict: "likely_authentic",
  verdict_confidence: 0.8,
  tell_findings: [],
  brand_assessed: "Coach",
  signals_examined: [],
  red_flags: ["stitching irregular"],
  supporting_signals: [],
  summary: "Consistent.",
  limitations: "…",
  model: "m",
  prompt_version: "authenticity_v1+tells",
  // deno-lint-ignore no-explicit-any
} as any;

Deno.test("payload carries the coarse verdict, the version, and the gate state", () => {
  const p = buildAuthenticityEventPayload(ASSESSED, false);
  assert(p);
  assertEquals(p.verdict, "likely_authentic");
  assertEquals(p.verdict_confidence, 0.8);
  assertEquals(p.brand_assessed, "Coach");
  assertEquals(p.prompt_version, "authenticity_v1+tells");
  // Written while the eval gate was unsatisfied — recorded so this entry stays
  // identifiable once the gate can actually pass.
  assertEquals(p.gated, false);
});

Deno.test("payload NEVER carries red flags or per-tell findings", () => {
  // The passport is buyer-visible. Leaking operator-side signals here would undo
  // the projection the public certificate view is careful about.
  const p = buildAuthenticityEventPayload(ASSESSED, true);
  assert(p);
  const keys = Object.keys(p);
  assertEquals(keys.includes("red_flags"), false);
  assertEquals(keys.includes("tell_findings"), false);
  assertEquals(keys.includes("supporting_signals"), false);
  assertEquals(keys.includes("summary"), false);
});

Deno.test("no event when the add-on didn't run", () => {
  assertEquals(buildAuthenticityEventPayload(null, true), null);
  assertEquals(buildAuthenticityEventPayload({ ...ASSESSED, assessed: false }, true), null);
});

Deno.test("no event when no brand was recognizable", () => {
  // 'inconclusive because there was no brand' is noise in a ledger meant to
  // carry findings.
  assertEquals(buildAuthenticityEventPayload({ ...ASSESSED, brand_assessed: null }, true), null);
});
