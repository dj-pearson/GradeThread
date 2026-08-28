import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";
import { nameProblem, TEMPLATE_NAME_MAX } from "@/lib/flipdesk-templates";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";

describe("STARTER_TEMPLATES", () => {
  it("ships at least four samples with unique ids and names", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(STARTER_TEMPLATES.map((t) => t.id));
    const names = new Set(STARTER_TEMPLATES.map((t) => t.name.toLowerCase()));
    expect(ids.size).toBe(STARTER_TEMPLATES.length);
    expect(names.size).toBe(STARTER_TEMPLATES.length);
  });

  it("every sample is savable by the editor's own validation", () => {
    for (const t of STARTER_TEMPLATES) {
      expect(nameProblem(t.name)).toBeNull();
      expect(t.name.length).toBeLessThanOrEqual(TEMPLATE_NAME_MAX);
      expect(t.body.trim().length).toBeGreaterThan(0);
      expect(t.conditionDescription.trim().length).toBeGreaterThan(0);
    }
  });

  it("only uses eBay conditions the editor can actually offer", () => {
    const allowed = new Set(EBAY_CONDITION_OPTIONS.map((o) => o.value));
    for (const t of STARTER_TEMPLATES) {
      expect(allowed, `${t.id} condition`).toContain(t.ebayCondition);
    }
  });

  it("carries no item specifics and no eBay policy ids", () => {
    // Those are ids from the seller's own eBay account. A starter that guessed
    // them would be wrong for every person who installed it.
    const allowedKeys = new Set([
      "id",
      "name",
      "body",
      "note",
      "ebayCondition",
      "conditionDescription",
    ]);
    for (const t of STARTER_TEMPLATES) {
      for (const key of Object.keys(t)) {
        expect(allowedKeys, `${t.id} sets ${key}`).toContain(key);
      }
    }
  });

  it("reads as a footer: no placeholders, no restated blocks", () => {
    for (const t of STARTER_TEMPLATES) {
      // US-2967 made the footer its own block, appended after the AI prose.
      // A {{placeholder}} would ship to a buyer as literal braces, and
      // measurements and the grade are blocks of their own (US-2965).
      expect(t.body).not.toMatch(/\{\{/);
      expect(t.conditionDescription).not.toMatch(/\{\{/);
    }
  });
});
