import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportMappingStep, ImportPreview } from "@/components/flipdesk/import-preview";
import {
  buildImportPayload,
  buildMapped,
  guessField,
  validateImportRows,
} from "@/lib/import-mapping";

// IMP-12: the dry run the seller sees before anything is saved.

const REF = new Date("2026-06-01T12:00:00Z");

function build(headers: string[], rows: string[][]) {
  const mapping = headers.map(guessField);
  const mapped = rows.map((r) => buildMapped(r, headers, mapping));
  const payload = buildImportPayload(mapped, undefined, REF);
  return { mapping, payload, validation: validateImportRows(mapped, payload, mapping) };
}

describe("ImportPreview", () => {
  it("states what will import and which rows will be skipped, by row number", () => {
    const { payload, validation } = build(
      ["Item #", "Title", "Purchase Date"],
      [
        ["A1", "", ""],
        ["A2", "", ""],
        ["A3", "", ""],
        ["A4", "Tee", "not a date"],
        ["A5", "Hat", "99/99/2026"],
        ["A4", "Tee copy", ""],
      ],
    );
    const html = renderToStaticMarkup(<ImportPreview payload={payload} validation={validation} />);
    expect(html).toContain("3 of 6 rows will import.");
    expect(html).toContain("3 rows have no title and will be skipped (rows 2, 3, 4).");
    expect(html).toContain("2 rows have a date we can&#x27;t read");
    expect(html).toContain("1 row repeat a SKU");
    expect(html).toContain("Show only problem rows");
  });

  it("shows the cap message before any POST", () => {
    const rows = Array.from({ length: 6000 }, (_, i) => [`T${i}`]);
    const { payload, validation } = build(["Title"], rows);
    const html = renderToStaticMarkup(<ImportPreview payload={payload} validation={validation} />);
    expect(html).toContain("more than 5,000 rows");
  });
});

describe("ImportMappingStep", () => {
  it("shows a sample value per column and warns on a doubled field", () => {
    const html = renderToStaticMarkup(
      <ImportMappingStep
        headers={["Title", "Brand", "Maker"]}
        mapping={["title", "brand", "brand"]}
        sample={["Levi 501", "Levi", "Levi Strauss"]}
        rowCount={1}
        preset={null}
        duplicateFields={["brand"]}
        onPresetChange={() => {}}
        onMappingChange={() => {}}
      />,
    );
    expect(html).toContain("e.g. Levi 501");
    expect(html).toContain("Two columns map to");
  });
});

describe("the page's button count is the dry run's count (IMP-12)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/import.tsx"), "utf8");
  it("labels the button from willImport and sends importableRows", () => {
    expect(src).toMatch(/Math\.min\(validation\.willImport, MAX_IMPORT_ROWS\)/);
    expect(src).toMatch(/importableRows\(payload, MAX_IMPORT_ROWS\)/);
    expect(src).not.toMatch(/Import \{rows\.length\} items/);
  });
});
