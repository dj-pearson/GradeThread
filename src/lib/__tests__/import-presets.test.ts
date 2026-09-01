import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyImportPreset,
  detectImportPreset,
  getImportPreset,
  IMPORT_PRESETS,
  normalizeHeader,
  PRESET_SIGNATURE_MIN,
} from "@/lib/import-presets";
import { IMPORT_FIELDS } from "@/lib/import-mapping";

// US-9209 AC1: the presets and the vault note carry the same headers, and a
// file that is not a competitor export never reads as one.

const ROOT = join(__dirname, "..", "..", "..");
const note = readFileSync(join(ROOT, "vault/30-platform/import-presets.md"), "utf8");

function noteHeaders(presetId: string): Map<string, string> {
  const section = note.split(`## ${presetId}`)[1]?.split("\n## ")[0] ?? "";
  const out = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*`?([a-z_]+)`?\s*\|/.exec(line);
    if (m) out.set(normalizeHeader(m[1]!), m[2]!);
  }
  return out;
}

describe("import presets (US-9209)", () => {
  it("every preset header maps to a real import field", () => {
    for (const p of IMPORT_PRESETS) {
      for (const [h, f] of Object.entries(p.headers)) {
        expect(h).toBe(normalizeHeader(h));
        expect(IMPORT_FIELDS).toContain(f);
      }
      for (const s of p.signature) expect(Object.keys(p.headers)).toContain(s);
    }
  });
  it("the vault note carries the same headers as the code, both ways", () => {
    for (const p of IMPORT_PRESETS) {
      const fromNote = noteHeaders(p.id);
      expect(fromNote.size, `${p.id}: no table in the note`).toBeGreaterThan(5);
      expect(Object.fromEntries(fromNote)).toEqual(p.headers);
    }
  });
  it("detection needs two signature headers and never fires on a plain sheet", () => {
    expect(PRESET_SIGNATURE_MIN).toBe(2);
    expect(detectImportPreset(["Title", "Brand", "Size", "Price", "Status"])).toBeNull();
    expect(detectImportPreset(["Title", "Date Added", "Marketplaces", "Sold On"])?.id).toBe("vendoo");
    expect(detectImportPreset(["Item Title", "COGS", "Sold Platform", "Keywords"])?.id).toBe("list-perfectly");
    expect(detectImportPreset([])).toBeNull();
  });
  it("applying a preset maps its headers and falls back to the generic guess", () => {
    const vendoo = getImportPreset("vendoo")!;
    const m = applyImportPreset(["Title", "Sold Price", "Marketplaces", "Tracking Number", "Mystery"], vendoo);
    expect(m).toEqual(["title", "sale_price", "skip", "tracking", "skip"]);
  });
  it("an unverified preset says so", () => {
    for (const p of IMPORT_PRESETS) {
      if (p.verified === null) {
        expect(note).toMatch(new RegExp(`${p.id}[\\s\\S]*not yet verified`, "i"));
      }
    }
  });
});
