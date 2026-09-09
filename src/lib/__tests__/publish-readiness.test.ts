import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EBAY_ASPECT_VALUE_MAX_LEN,
  overlongAspectValues,
  readinessForChannel,
  readinessForChannels,
  summarizeReadiness,
} from "../publish-readiness";
import { projectDraftFields, type CrossListDraft } from "../marketplace-specs";
import { countFilled, countRequiredFilled, fillLabel, isFilled } from "../section-completeness";

const here = dirname(fileURLToPath(import.meta.url));

const COMPLETE: CrossListDraft = {
  title: "Patagonia Better Sweater Fleece Jacket Mens Medium Navy",
  description: "Pre-owned Patagonia Better Sweater in navy. No holes or stains. Ships next day.",
  price: 68,
  category: "57988",
  grade: 8.2,
  gradeLabel: "Excellent",
  brand: "Patagonia",
  size: "M",
  color: "Navy",
  tags: ["patagonia", "fleece"],
};

describe("readinessForChannel", () => {
  it("a channel with no listing path is unchecked, never ready", () => {
    // Whatnot HAS a spec (title cap, conditions) and no listing path at all
    // (US-2327), so "no spec" is not the reason it cannot be checked.
    const r = readinessForChannel("whatnot", { draft: COMPLETE });
    expect(r.status).toBe("unchecked");
    expect(r.note).toMatch(/no listing path/i);
    expect(r.blockers).toEqual([]);
  });

  it("an extension channel that passes every check is ready_in_browser, not ready", () => {
    const r = readinessForChannel("poshmark", { draft: COMPLETE, photoCount: 4 });
    expect(r.blockers).toEqual([]);
    expect(r.status).toBe("ready_in_browser");
    expect(r.mechanism).toBe("extension");
  });

  it("an empty title blocks a channel that requires one", () => {
    const r = readinessForChannel("poshmark", {
      draft: { ...COMPLETE, title: "" },
      photoCount: 4,
    });
    expect(r.status).toBe("blocked");
    expect(r.blockers.join(" ")).toMatch(/required/i);
  });

  it("an over-length title is NOT a blocker, because the publish path clamps it first", () => {
    // The 220-character title arrives at eBay as 80. Reporting it as an error
    // would show a failure the publish never produces.
    const long = "Vintage ".repeat(30).trim();
    expect(long.length).toBeGreaterThan(80);
    const r = readinessForChannel("poshmark", {
      draft: { ...COMPLETE, title: long },
      photoCount: 4,
    });
    expect(r.blockers.filter((b) => /title/i.test(b))).toEqual([]);
  });

  it("too many photos blocks, using the platform's own cap", () => {
    const r = readinessForChannel("poshmark", { draft: COMPLETE, photoCount: 999 });
    expect(r.status).toBe("blocked");
    expect(r.blockers.join(" ")).toMatch(/photos/i);
  });

  it("a per-platform override wins over the shared draft", () => {
    const r = readinessForChannel("poshmark", {
      draft: { ...COMPLETE, title: "" },
      photoCount: 4,
      overrides: { poshmark: { title: "Patagonia Better Sweater Fleece Jacket" } },
    });
    expect(r.blockers.filter((b) => /title/i.test(b))).toEqual([]);
  });
});

describe("eBay's server preflight is merged, not re-derived", () => {
  it("says so when the preflight has not run, rather than claiming ready", () => {
    const r = readinessForChannel("ebay", { draft: COMPLETE, photoCount: 4 });
    expect(r.warnings.join(" ")).toMatch(/hasn't run yet/i);
  });

  it("carries the server's blockers through verbatim", () => {
    const r = readinessForChannel("ebay", {
      draft: COMPLETE,
      photoCount: 4,
      ebay: { ran: true, blockers: ["Item specifics: Department is required"] },
    });
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("Item specifics: Department is required");
  });

  it("reports a missing recommended aspect as a warning, not a blocker", () => {
    const r = readinessForChannel("ebay", {
      draft: COMPLETE,
      photoCount: 4,
      ebay: { ran: true, missingRecommendedAspects: ["Fabric Type"] },
    });
    expect(r.status).toBe("ready");
    expect(r.warnings.join(" ")).toMatch(/Fabric Type/);
  });

  it("a duplicate blocker from both checks is listed once", () => {
    const r = readinessForChannel("ebay", {
      draft: { ...COMPLETE, title: "" },
      photoCount: 4,
      ebay: { ran: true, blockers: ["Title is required"] },
    });
    const titleBlockers = r.blockers.filter((b) => b === "Title is required");
    expect(titleBlockers).toHaveLength(1);
  });
});

describe("overlongAspectValues", () => {
  it("flags a value past the 65-character ceiling as a shortening warning", () => {
    const long = "x".repeat(EBAY_ASPECT_VALUE_MAX_LEN + 1);
    const out = overlongAspectValues({ Material: [long] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/shorten/i);
  });

  it("a value exactly at the ceiling is fine", () => {
    expect(overlongAspectValues({ Material: ["x".repeat(EBAY_ASPECT_VALUE_MAX_LEN)] })).toEqual([]);
  });

  it("no aspects means no warnings", () => {
    expect(overlongAspectValues(null)).toEqual([]);
    expect(overlongAspectValues(undefined)).toEqual([]);
  });
});

describe("readinessForChannels", () => {
  it("returns one row per selected channel and nothing for the rest", () => {
    const rows = readinessForChannels({
      platforms: ["poshmark", "mercari"],
      draft: COMPLETE,
      photoCount: 4,
    });
    expect(rows.map((r) => r.platform)).toEqual(["poshmark", "mercari"]);
  });

  it("summarizes blocked channels so the CTA can warn before the press", () => {
    const rows = readinessForChannels({
      platforms: ["poshmark", "whatnot"],
      draft: { ...COMPLETE, title: "" },
      photoCount: 4,
    });
    const s = summarizeReadiness(rows);
    expect(s.blocked).toBe(1);
    expect(s.unchecked).toBe(1);
    expect(s.anyBlocked).toBe(true);
  });
});

describe("the projection is shared with the publish path, not copied", () => {
  it("the edge preflight calls projectDraftFields rather than inlining its own map", () => {
    // The guarantee this whole module rests on: cross-push validates through
    // the same projection the composer previews with. If someone re-inlines the
    // field map in the edge module, the readout silently becomes a guess again.
    const edge = readFileSync(
      resolve(here, "../../../services/edge-functions/src/lib/cross-listing-fields.ts"),
      "utf8",
    );
    expect(edge).toMatch(/projectDraftFields\(/);
    expect(edge).toMatch(/from "\.\/marketplace-specs\.ts"/);
  });

  it("projectDraftFields writes both spellings of the aliased fields", () => {
    const fields = projectDraftFields("grailed", COMPLETE);
    expect(fields.brand).toBe("Patagonia");
    expect(fields.designer).toBe("Patagonia");
    expect(fields.category).toBe("57988");
    expect(fields.department).toBe("57988");
  });

  it("Depop, which has no title field, projects an empty title rather than a stray one", () => {
    expect(projectDraftFields("depop", COMPLETE).title).toBe("");
  });
});

describe("section completeness", () => {
  it("counts blanks, empty strings and empty arrays as unfilled", () => {
    const fill = countFilled(["a", "", null, undefined, [], ["x"]]);
    expect(fill.filled).toBe(2);
    expect(fill.total).toBe(6);
    expect(fill.complete).toBe(false);
  });

  it("a deliberate false or zero counts as answered", () => {
    expect(isFilled(false)).toBe(true);
    expect(isFilled(0)).toBe(true);
    expect(isFilled(Number.NaN)).toBe(false);
  });

  it("the denominator comes from the values passed, never a constant", () => {
    expect(fillLabel(countFilled(["a", "b", "c"]))).toBe("3 of 3");
    expect(fillLabel(countFilled(["a", "b", "c", ""]))).toBe("3 of 4");
  });

  it("an empty section is 0 of 0 and not complete", () => {
    const fill = countFilled([]);
    expect(fill.fraction).toBe(0);
    expect(fill.complete).toBe(false);
  });

  it("countRequiredFilled ignores fields marked optional", () => {
    const fill = countRequiredFilled([
      { value: "set" },
      { value: "", required: true },
      { value: "", required: false },
    ]);
    expect(fill.total).toBe(2);
    expect(fill.filled).toBe(1);
  });
});
