import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { conditionLine, STARTER_TEMPLATES } from "@/lib/starter-templates";
import { nameProblem, TEMPLATE_NAME_MAX } from "@/lib/flipdesk-templates";
import {
  APPAREL_CONDITION_IDS,
  APPAREL_CONDITION_LABELS,
  EBAY_CONDITION_ENUM_TO_ID,
  EBAY_CONDITION_OPTIONS,
} from "@/lib/constants";

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
      // The picker's labelled condition and note, derived from the two above.
      "details",
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

  it("every condition is one apparel leaves accept at publish", () => {
    // USED_GOOD (5000) is refused by most clothing categories, and the picker
    // offered it on two starters.
    for (const t of STARTER_TEMPLATES) {
      const id = EBAY_CONDITION_ENUM_TO_ID[t.ebayCondition];
      expect(id, `${t.id} has no conditionId`).toBeDefined();
      expect(APPAREL_CONDITION_IDS.has(id!), `${t.id} uses ${t.ebayCondition}`).toBe(true);
    }
  });

  it("each picker note is the label of the condition it saves", () => {
    for (const t of STARTER_TEMPLATES) {
      const label = APPAREL_CONDITION_LABELS[EBAY_CONDITION_ENUM_TO_ID[t.ebayCondition]!];
      expect(t.note).toBe(`Condition: ${label}`);
      expect(t.note).toBe(conditionLine(t.ebayCondition));
    }
  });

  it("the enum-to-id map is the edge preflight's", () => {
    const src = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/publish-preflight.ts"),
      "utf8",
    );
    const start = src.indexOf("export const CONDITION_ENUM_TO_ID");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("};", start));
    const edge: Record<string, string> = {};
    for (const m of body.matchAll(/^\s+(\w+): "(\d+)",/gm)) edge[m[1]!] = m[2]!;
    expect(Object.keys(edge).length).toBeGreaterThan(8);
    expect(EBAY_CONDITION_ENUM_TO_ID).toEqual(edge);
  });
});
