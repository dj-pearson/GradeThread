// US-1296: Forensic Grade — paid defect-zoom re-analysis add-on.
//
// Covers (per AC #4) the entitlement gating — the paid zoom path runs ONLY when
// the add-on is genuinely enabled — and that a refined defect is marked so the
// report can show which defects were zoom-refined.
//
// grade-pricing.ts is dependency-free (pure) so it's a static import; ai-grading.ts
// transitively pulls in lib/supabase.ts (which throws at import unless the env is
// set), so its runtime helper is DYNAMIC-imported after the env dance, while its
// types are type-only static imports (erased at runtime — no module eval).

import { assert, assertEquals } from "@std/assert";
import {
  forensicAddonEnabled,
  type GradeTier,
  tierSupportsForensicAddon,
} from "../lib/grade-pricing.ts";
import type { DetectedIssue, PerImageAnalysis } from "../lib/ai-grading.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { mergeZoomIntoIssue } = await import("../lib/ai-grading.ts");

// --- Entitlement gating: tier support ---

Deno.test("tierSupportsForensicAddon: only paid Premium/Express tiers", () => {
  assert(tierSupportsForensicAddon("premium"));
  assert(tierSupportsForensicAddon("express"));
  assert(!tierSupportsForensicAddon("standard"));
});

// --- Entitlement gating: the full decision (zoom runs only when enabled) ---

const ALL_ON = {
  optIn: true,
  tier: "premium" as GradeTier,
  retainOriginals: true,
  featureEnabled: true,
};

Deno.test("forensicAddonEnabled: enabled only when every condition holds", () => {
  assert(forensicAddonEnabled(ALL_ON));
});

Deno.test("forensicAddonEnabled: no opt-in → not enabled", () => {
  assert(!forensicAddonEnabled({ ...ALL_ON, optIn: false }));
});

Deno.test("forensicAddonEnabled: Standard tier → not enabled (gated to paid tiers)", () => {
  assert(!forensicAddonEnabled({ ...ALL_ON, tier: "standard" }));
});

Deno.test("forensicAddonEnabled: originals not retained → not enabled (US-339 required)", () => {
  assert(!forensicAddonEnabled({ ...ALL_ON, retainOriginals: false }));
});

Deno.test("forensicAddonEnabled: feature flag off → not enabled (kill-switch)", () => {
  assert(!forensicAddonEnabled({ ...ALL_ON, featureEnabled: false }));
});

// --- Report marking: refined defects are flagged ---

function issue(p: Partial<DetectedIssue>): DetectedIssue {
  return {
    issue: "small hole",
    severity: "minor",
    location: "left cuff",
    is_intentional: false,
    size_bucket: "small",
    size_confidence: 0.5,
    ...p,
  };
}

function zoomResult(issues: DetectedIssue[]): PerImageAnalysis {
  return {
    image_type: "defect",
    detected_issues: issues,
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 8,
      structural_integrity: 8,
      cosmetic_appearance: 8,
      functional_elements: 8,
      odor_cleanliness: 8,
    },
  };
}

Deno.test("mergeZoomIntoIssue: a high-res confirmed defect is marked zoom_refined", () => {
  const original = issue({ size_bucket: "small", severity: "minor" });
  const zoom = zoomResult([
    issue({ size_bucket: "medium", severity: "moderate", size_confidence: 0.9 }),
  ]);
  const merged = mergeZoomIntoIssue(original, zoom);
  assertEquals(merged.zoom_refined, true);
  // The crop's higher-fidelity read is taken (larger size / more severe).
  assertEquals(merged.size_bucket, "medium");
  assertEquals(merged.severity, "moderate");
});

Deno.test("mergeZoomIntoIssue: zoom finds nothing genuine → still marked refined, confidence lowered", () => {
  const original = issue({ size_confidence: 0.6 });
  const zoom = zoomResult([issue({ is_intentional: true })]);
  const merged = mergeZoomIntoIssue(original, zoom);
  assertEquals(merged.zoom_refined, true);
  assert((merged.size_confidence ?? 1) <= 0.3);
});
