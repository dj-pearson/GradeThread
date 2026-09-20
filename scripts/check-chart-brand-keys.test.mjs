import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  brandKey,
  duplicateCharts,
  KNOWN_CONVENTION_KEYS,
  parseRows,
  staleKnown,
  unreachableRows,
} from "./check-chart-brand-keys.mjs";

// US-3443. The check's value is that it reproduces, from the table, the four
// rows that were found by comparing the seed against it. If it stops doing
// that it has become a script that prints a tick.

const row = (key, label, department = "Men", garment = "Tops") => ({
  key,
  label,
  department,
  garment,
});

describe("chart brand keys (US-3443)", () => {
  it("copies the resolver's brandKey exactly, accent-dropping and all", () => {
    // Pinned against the real source rather than described, because the whole
    // defect is that an accented letter is DROPPED and not transliterated, and
    // a copy that quietly started transliterating would report a clean table
    // while grading kept reading the other row.
    const src = readFileSync(
      "services/edge-functions/src/lib/brand-normalize.ts",
      "utf8",
    );
    expect(src).toContain('raw.toLowerCase().replace(/[^a-z0-9]/g, "")');
    expect(brandKey("Kühl")).toBe("khl");
    expect(brandKey("Fjällräven")).toBe("fjllrven");
    expect(brandKey("The North Face")).toBe("thenorthface");
    expect(brandKey("7 For All Mankind")).toBe("7forallmankind");
  });

  it("reports a row the resolver can never reach", () => {
    const rows = [
      row("kuhl", "Kühl"),
      row("thenorthface", "The North Face"),
    ];
    expect(unreachableRows(rows).map((r) => r.key)).toEqual(["kuhl"]);
  });

  it("does not report the named convention keys", () => {
    const rows = [row("tailoringmenswear", "Menswear tailoring (US convention)")];
    expect(unreachableRows(rows)).toEqual([]);
    // ... and reports one that is not named, which is the point of the list.
    expect(
      unreachableRows([row("shirtwidth", "Dress shirt widths (US convention)")])
        .map((r) => r.key),
    ).toEqual(["shirtwidth"]);
  });

  it("finds the same chart stored under two keys", () => {
    const rows = [
      row("khl", "Kühl", "Men", "Apparel"),
      row("kuhl", "Kühl", "Men", "Apparel"),
      row("khl", "Kühl", "Women", "Apparel"),
    ];
    const d = duplicateCharts(rows);
    expect(d).toHaveLength(1);
    expect(d[0].keys).toEqual(["khl", "kuhl"]);
    expect(d[0].department).toBe("Men");
  });

  it("the convention baseline may only shrink", () => {
    // Every named key must still describe a real row whose key differs from
    // brandKey(label). A fixed one has to leave the list in the same commit,
    // or the list goes on excusing an exposure that closed.
    const rows = [row("tailoringmenswear", "Menswear tailoring (US convention)")];
    expect(staleKnown(rows, ["tailoringmenswear"])).toEqual([]);
    expect(staleKnown(rows, ["tailoringmenswear", "goorinbros"])).toEqual([
      "goorinbros",
    ]);
  });

  it("parses psql's tab output and ignores everything else", () => {
    const out = [
      "NOTICE:  something",
      "khl\tKühl\tMen\tApparel (US alpha tops)",
      "",
      "thenorthface\tThe North Face\tWomen\tJackets & tops",
      "(2 rows)",
    ].join("\n");
    expect(parseRows(out)).toEqual([
      { key: "khl", label: "Kühl", department: "Men", garment: "Apparel (US alpha tops)" },
      {
        key: "thenorthface",
        label: "The North Face",
        department: "Women",
        garment: "Jackets & tops",
      },
    ]);
  });

  it("names three convention keys and no more", () => {
    // A guard against this list growing quietly into a way to excuse a real
    // unreachable row. Adding one is a decision and should change this number.
    expect(KNOWN_CONVENTION_KEYS).toEqual([
      "golfshoewidth",
      "tailoringmenswear",
      "westernbootwidth",
    ]);
  });
});
