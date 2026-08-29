import { describe, expect, it } from "vitest";
import {
  TEMPLATE_COLUMNS,
  TEMPLATE_FILENAME,
  buildInventoryTemplateCsv,
  csvCell,
} from "@/lib/reseller-inventory-template";
import { getCalculatorBySlug } from "@/lib/seo/calculators";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";

// US-9022. The file IS the page, so a defect here ships a broken download to
// the one search term in either keyword pull with a $21.71 bid on it.

function parseRow(line: string): string[] {
  // Minimal RFC 4180 reader, so the test verifies the QUOTING rather than
  // trusting the writer's own escaping.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe("csvCell", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("Patagonia")).toBe("Patagonia");
  });

  it("quotes a value containing a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("doubles inner quotes", () => {
    // Every calculated column contains "" for the empty-string test, so this
    // is the escaping the whole file depends on.
    expect(csvCell('=IF(N2="","",1)')).toBe('"=IF(N2="""","""",1)"');
  });
});

describe("buildInventoryTemplateCsv", () => {
  const csv = buildInventoryTemplateCsv(10);
  const lines = csv.trimEnd().split("\r\n");

  it("uses CRLF, which is what Excel expects from a CSV", () => {
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("puts the headers in row 1, in registry order", () => {
    expect(parseRow(lines[0]!)).toEqual(TEMPLATE_COLUMNS.map((c) => c.header));
  });

  it("gives every row the same number of fields as the header", () => {
    for (const [i, line] of lines.entries()) {
      expect(parseRow(line), `row ${i + 1}`).toHaveLength(TEMPLATE_COLUMNS.length);
    }
  });

  it("carries the condition grade column, which is the reason the page exists", () => {
    const headers = parseRow(lines[0]!);
    expect(headers).toContain("Condition grade");
    // On the 1.0-10.0 scale, and the examples have to demonstrate it or the
    // column reads as optional.
    expect(csv).toMatch(/,7\.5,/);
  });

  it("re-numbers the formulas per row rather than repeating row 2", () => {
    const netIndex = TEMPLATE_COLUMNS.findIndex((c) => c.header === "Net profit");
    // Row 2 and 3 are examples with a formula in the calculated columns.
    // lines[0] is the header, so lines[n] is spreadsheet row n + 1.
    const row4 = parseRow(lines[3]!)[netIndex]!;
    const row5 = parseRow(lines[4]!)[netIndex]!;
    expect(row4).toContain("N4");
    expect(row5).toContain("N5");
    expect(row4).not.toEqual(row5);
  });

  it("leaves the calculated columns empty until there is a sold price", () => {
    // A template whose profit column shows #VALUE! or 0 on every blank row
    // looks broken the moment it opens.
    const netIndex = TEMPLATE_COLUMNS.findIndex((c) => c.header === "Net profit");
    expect(parseRow(lines[5]!)[netIndex]).toMatch(/^=IF\(N6="","",/);
  });

  it("guards the margin column against dividing by zero", () => {
    const marginIndex = TEMPLATE_COLUMNS.findIndex((c) => c.header === "Margin");
    expect(parseRow(lines[5]!)[marginIndex]).toContain("=0");
  });

  it("shows all three states a row is ever in", () => {
    // sold, listed-and-waiting, sourced-but-not-listed. A template whose only
    // example is a completed sale does not show a half-filled row.
    const soldIndex = TEMPLATE_COLUMNS.findIndex((c) => c.header === "Sold price");
    const listedIndex = TEMPLATE_COLUMNS.findIndex((c) => c.header === "Date listed");
    expect(parseRow(lines[1]!)[soldIndex]).toBe("65.00");
    expect(parseRow(lines[2]!)[soldIndex]).toBe("");
    expect(parseRow(lines[2]!)[listedIndex]).not.toBe("");
    expect(parseRow(lines[3]!)[listedIndex]).toBe("");
  });

  it("never returns fewer rows than it has examples", () => {
    expect(buildInventoryTemplateCsv(1).trimEnd().split("\r\n")).toHaveLength(4);
  });

  it("downloads with a name that says whose it is", () => {
    expect(TEMPLATE_FILENAME).toMatch(/^gradethread-.*\.csv$/);
  });
});

describe("the page is registered", () => {
  it("is live with content and a handoff", () => {
    const calc = getCalculatorBySlug("reseller-inventory-spreadsheet");
    expect(calc?.status).toBe("live");
    expect(calc?.intro).toBeTruthy();
    expect(calc?.faqs?.length).toBeGreaterThanOrEqual(4);
    expect(calc?.handoff?.surface).toBe("inventory-management");
  });

  it("owns the head keyword", () => {
    const target = KEYWORD_TARGETS.find(
      (t) => t.path === "/tools/reseller-inventory-spreadsheet",
    );
    expect(target?.primary).toBe("reseller inventory spreadsheet");
    const calc = getCalculatorBySlug("reseller-inventory-spreadsheet")!;
    expect(`${calc.title} ${calc.description}`.toLowerCase()).toContain(
      "reseller inventory spreadsheet",
    );
  });

  it("promises no email gate, because gating it would lose the ranking", () => {
    const calc = getCalculatorBySlug("reseller-inventory-spreadsheet")!;
    expect(`${calc.intro} ${calc.description}`).toMatch(/no email/i);
  });
});
