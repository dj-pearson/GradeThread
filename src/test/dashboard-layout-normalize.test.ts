import { describe, it, expect } from "vitest";
import { layoutDocument, normalize, personaOf } from "@/lib/dashboard-layout";
import {
  LAYOUT_VERSION,
  defaultLayoutFor,
  widgetsForSurface,
  type WidgetDef,
} from "@/lib/dashboard-widgets";

// US-3073 AC3: one test per branch of the normalizer. A stored layout is data
// an older client wrote against an older registry, so every one of these is a
// case production will actually produce.

const registry = widgetsForSurface("grading");
const sellerDefault = defaultLayoutFor("grading", "seller");

function doc(widgets: unknown, version: unknown = LAYOUT_VERSION) {
  return { version, widgets };
}

describe("normalize", () => {
  it("keeps a well-formed layout as written", () => {
    const stored = doc([
      { id: "grading.invite", size: "sm" },
      { id: "grading.usage", size: "lg" },
    ]);
    expect(normalize(stored, registry, "seller")).toEqual([
      { id: "grading.invite", size: "sm" },
      { id: "grading.usage", size: "lg" },
    ]);
  });

  it("drops an id the registry does not know", () => {
    const stored = doc([
      { id: "grading.retired-in-2027", size: "md" },
      { id: "grading.usage", size: "lg" },
    ]);
    expect(normalize(stored, registry, "seller")).toEqual([
      { id: "grading.usage", size: "lg" },
    ]);
  });

  it("drops a widget that belongs to another surface", () => {
    const stored = doc([{ id: "grading.usage", size: "lg" }]);
    expect(normalize(stored, widgetsForSurface("flipdesk"), "seller")).toEqual([]);
  });

  it("clamps a size the widget does not allow to its defaultSize", () => {
    const charts = registry.find((w) => w.id === "grading.charts")!;
    expect(charts.sizes).not.toContain("sm");
    const stored = doc([{ id: "grading.charts", size: "sm" }]);
    expect(normalize(stored, registry, "seller")).toEqual([
      { id: "grading.charts", size: charts.defaultSize },
    ]);
  });

  it("clamps a size that is not a size at all", () => {
    const usage = registry.find((w) => w.id === "grading.usage")!;
    for (const size of [undefined, null, 42, "huge"]) {
      const stored = doc([{ id: "grading.usage", size }]);
      expect(normalize(stored, registry, "seller")).toEqual([
        { id: "grading.usage", size: usage.defaultSize },
      ]);
    }
  });

  it("dedupes a repeated id, keeping the first occurrence", () => {
    const stored = doc([
      { id: "grading.impact", size: "sm" },
      { id: "grading.usage", size: "lg" },
      { id: "grading.impact", size: "md" },
    ]);
    expect(normalize(stored, registry, "seller")).toEqual([
      { id: "grading.impact", size: "sm" },
      { id: "grading.usage", size: "lg" },
    ]);
  });

  it("returns the persona default when the document is missing", () => {
    for (const missing of [null, undefined]) {
      expect(normalize(missing, registry, "seller")).toEqual(sellerDefault);
    }
  });

  it("returns the persona default when the document is malformed", () => {
    const malformed: unknown[] = [
      "not a document",
      42,
      [],
      [{ id: "grading.usage", size: "lg" }],
      {},
      doc("not an array"),
      doc(null),
    ];
    for (const stored of malformed) {
      expect(normalize(stored, registry, "seller")).toEqual(sellerDefault);
    }
  });

  it("returns the persona default when the version is unknown", () => {
    // Built inline rather than through doc(), whose default parameter would
    // turn an explicit `undefined` version back into the current one.
    for (const version of [0, LAYOUT_VERSION + 1, "1", null, undefined]) {
      const stored = { version, widgets: [{ id: "grading.usage", size: "sm" }] };
      expect(normalize(stored, registry, "seller")).toEqual(sellerDefault);
    }
  });

  it("returns the matching persona's default, not the seller's", () => {
    expect(normalize(null, registry, "buyer")).toEqual(defaultLayoutFor("grading", "buyer"));
    expect(normalize(null, registry, "developer")).toEqual(
      defaultLayoutFor("grading", "developer"),
    );
  });

  it("normalizes the persona default too, so a stale default cannot ship a bad size", () => {
    const shrunk: WidgetDef[] = registry
      .filter((w) => w.id === "grading.usage")
      .map((w) => ({ ...w, sizes: ["md"], defaultSize: "md" }));
    // The shipped seller default asks for grading.usage at lg; this registry
    // only allows md, and every other default widget is gone.
    expect(normalize(null, shrunk, "seller")).toEqual([{ id: "grading.usage", size: "md" }]);
  });

  it("skips entries that are not objects with a string id", () => {
    const stored = doc([null, 7, "grading.usage", { size: "lg" }, { id: 5 }, { id: "grading.usage" }]);
    const usage = registry.find((w) => w.id === "grading.usage")!;
    expect(normalize(stored, registry, "seller")).toEqual([
      { id: "grading.usage", size: usage.defaultSize },
    ]);
  });

  it("honors an empty board as a choice rather than resetting it", () => {
    expect(normalize(doc([]), registry, "seller")).toEqual([]);
  });

  it("returns an empty layout when the registry is empty", () => {
    expect(normalize(null, [], "seller")).toEqual([]);
  });

  it("round-trips through layoutDocument", () => {
    const document = layoutDocument(sellerDefault);
    expect(document.version).toBe(LAYOUT_VERSION);
    expect(normalize(document, registry, "seller")).toEqual(sellerDefault);
  });

  it("copies entries into the document rather than aliasing them", () => {
    const entries = [{ id: "grading.usage", size: "lg" as const }];
    const document = layoutDocument(entries);
    entries[0].id = "grading.impact";
    expect(document.widgets[0].id).toBe("grading.usage");
  });
});

describe("personaOf", () => {
  it("passes through the four known personas", () => {
    for (const persona of ["seller", "buyer", "consignment", "developer"] as const) {
      expect(personaOf(persona)).toBe(persona);
    }
  });

  it("falls back to seller for an account that never chose", () => {
    expect(personaOf(null)).toBe("seller");
    expect(personaOf(undefined)).toBe("seller");
    expect(personaOf("reseller")).toBe("seller");
  });
});
