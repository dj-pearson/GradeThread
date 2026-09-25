import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportSourcePicker } from "@/components/flipdesk/import-source-picker";

// IMP-13: step 1 of the Import page. What can be driven without a DOM is
// rendered for real; the event wiring is read off the source, and says so.

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/flipdesk/import-source-picker.tsx"),
  "utf8",
);

function render(props: Partial<Parameters<typeof ImportSourcePicker>[0]> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ImportSourcePicker
        disabled={false}
        loaded={null}
        onLoad={() => 1}
        onDownloadTemplate={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("ImportSourcePicker", () => {
  it("puts File first and makes the file control a real button", () => {
    const html = render();
    expect(html.indexOf(">File<")).toBeLessThan(html.indexOf(">Google Sheet<"));
    expect(html.indexOf(">Google Sheet<")).toBeLessThan(html.indexOf(">Paste<"));
    // A <button>, so Tab reaches it and Enter opens the picker.
    expect(html).toMatch(/<button[^>]*>.*Choose CSV file<\/button>/s);
    expect(html).not.toMatch(/<label[^>]*for="csv-file-input"/);
  });

  it("shows the loaded file as a chip with a Replace action, in a live region", () => {
    const html = render({ loaded: { from: "csv", name: "inventory.csv", rows: 412 } });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("inventory.csv");
    expect(html).toContain("412 rows");
    expect(html).toContain("Replace");
  });

  it("takes a drop on the zone and stops a stray drop from navigating away", () => {
    expect(SRC).toMatch(/onDrop=\{\(e\) => \{\s*e\.preventDefault\(\);/);
    expect(SRC).toMatch(/window\.addEventListener\("drop", stop\)/);
    expect(SRC).toMatch(/window\.addEventListener\("dragover", stop\)/);
  });

  it("re-picking the same file reloads it", () => {
    expect(SRC).toMatch(/e\.target\.value = "";/);
  });

  it("decodes files through decodeTextFile, not file.text()", () => {
    expect(SRC).toContain("decodeTextFile(await file.arrayBuffer())");
    expect(SRC).not.toContain("file.text()");
  });

  it("reports where the data came from, so a paste is recorded as 'paste'", () => {
    expect(SRC).toContain('onLoad(pasted, "paste", "Pasted rows")');
    expect(SRC).toContain('onLoad(csv, "sheet", "Google Sheet")');
    const page = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/import.tsx"), "utf8");
    expect(page).toContain('origin: loaded?.from ?? "csv"');
  });

  it("does not force a 260px minimum width on a phone", () => {
    expect(SRC).not.toMatch(/(?<!sm:)min-w-\[260px\]/);
  });
});
