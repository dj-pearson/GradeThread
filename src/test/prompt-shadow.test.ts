// The admin shadow-run form (grading.md action 6).
//
// Before this, no file under src/ called PATCH /prompts/:id/shadow, yet the
// Shadow tab told operators to "start a shadow run from a draft prompt
// version". These pin the form's rules to the edge's, and pin the page to the
// route so the empty-state copy stays true.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildShadowStartBody,
  maxShadowPercent,
  PER_IMAGE_SHADOW_MAX_SAMPLE_RATE,
} from "@/lib/prompt-shadow";

const read = (p: string) => readFileSync(p, "utf8");

describe("buildShadowStartBody", () => {
  it("turns a percent into the stored rate", () => {
    expect(buildShadowStartBody("composite", { ratePercent: "10", dailyCap: "200" })).toEqual({
      ok: true,
      body: { is_shadow: true, shadow_sample_rate: 0.1, shadow_daily_cap: 200 },
    });
    expect(buildShadowStartBody("per_image", { ratePercent: "2.5", dailyCap: "20" })).toEqual({
      ok: true,
      body: { is_shadow: true, shadow_sample_rate: 0.025, shadow_daily_cap: 20 },
    });
  });

  it("caps per_image at the edge's ceiling, and allows the ceiling itself", () => {
    const max = PER_IMAGE_SHADOW_MAX_SAMPLE_RATE * 100;
    expect(buildShadowStartBody("per_image", { ratePercent: String(max), dailyCap: "10" }).ok).toBe(true);
    expect(buildShadowStartBody("per_image", { ratePercent: String(max + 1), dailyCap: "10" }).ok).toBe(false);
    // The same number is fine for a composite shadow.
    expect(buildShadowStartBody("composite", { ratePercent: String(max + 1), dailyCap: "10" }).ok).toBe(true);
  });

  it("refuses the settings that would start a shadow that never runs", () => {
    for (const input of [
      { ratePercent: "0", dailyCap: "10" },
      { ratePercent: "", dailyCap: "10" },
      { ratePercent: "2", dailyCap: "0" },
      { ratePercent: "2", dailyCap: "1.5" },
      { ratePercent: "abc", dailyCap: "10" },
    ]) {
      expect(buildShadowStartBody("per_image", input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it("maxShadowPercent follows the stage", () => {
    expect(maxShadowPercent("composite")).toBe(100);
    expect(maxShadowPercent("per_image")).toBe(PER_IMAGE_SHADOW_MAX_SAMPLE_RATE * 100);
  });
});

describe("parity with the edge", () => {
  it("the per_image ceiling matches prompt-shadow-toggle.ts", () => {
    const edge = read("services/edge-functions/src/lib/prompt-shadow-toggle.ts");
    const m = /export const PER_IMAGE_SHADOW_MAX_SAMPLE_RATE = ([\d.]+);/.exec(edge);
    expect(m, "edge constant not found").toBeTruthy();
    expect(Number(m![1])).toBe(PER_IMAGE_SHADOW_MAX_SAMPLE_RATE);
  });

  it("the edge route no longer refuses per_image rows", () => {
    const routes = read("services/edge-functions/src/routes/admin-grading.ts");
    expect(routes).not.toContain("Only composite-stage prompts can be shadowed");
    expect(routes).toMatch(/planShadowToggle\(/);
  });
});

describe("the admin page can do what the Shadow tab says", () => {
  it("ai-models.tsx calls the shadow route", () => {
    const page = read("src/pages/admin/ai-models.tsx");
    expect(page).toMatch(/promptsApi\(`\/\$\{shadowTarget\.id\}\/shadow`/);
    expect(page).toContain("is_shadow: false");
  });

  it("the empty state points at the control that exists", () => {
    const panel = read("src/components/admin/grading-accuracy-panel.tsx");
    expect(panel).not.toContain("start a shadow run from a draft prompt version and");
    expect(panel).toMatch(/shadow button on a draft row/);
  });
});
