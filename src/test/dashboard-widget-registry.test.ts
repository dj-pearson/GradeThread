import { describe, it, expect } from "vitest";
import {
  DASHBOARD_SURFACES,
  DASHBOARD_WIDGETS,
  DEFAULT_LAYOUTS,
  WIDGET_CATEGORIES,
  WIDGET_PERSONAS,
  WIDGET_SIZES,
  WIDGET_SIZE_COLUMNS,
  defaultLayoutFor,
  widgetById,
  widgetsForSurface,
} from "@/lib/dashboard-widgets";

// US-3073 AC2: the registry's own invariants. Every later widget story adds
// entries here, so these run against whatever the registry grows into.

describe("dashboard widget registry", () => {
  it("gives every widget a unique id", () => {
    const ids = DASHBOARD_WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers every widget on a known surface, category and persona set", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(DASHBOARD_SURFACES).toContain(widget.surface);
      expect(WIDGET_CATEGORIES).toContain(widget.category);
      expect(widget.personas.length).toBeGreaterThan(0);
      for (const persona of widget.personas) {
        expect(WIDGET_PERSONAS).toContain(persona);
      }
      expect(widget.title.length).toBeGreaterThan(0);
      expect(widget.blurb.length).toBeGreaterThan(0);
    }
  });

  it("offers each widget at least one size, with its default among them", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(widget.sizes.length).toBeGreaterThan(0);
      for (const size of widget.sizes) expect(WIDGET_SIZES).toContain(size);
      expect(widget.sizes).toContain(widget.defaultSize);
    }
  });

  it("only marks a widget range-aware on the flipdesk surface", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      if (widget.rangeAware) expect(widget.surface).toBe("flipdesk");
    }
  });

  it("maps the three sizes onto columns of the 4-column grid", () => {
    expect(WIDGET_SIZE_COLUMNS).toEqual({ sm: 1, md: 2, lg: 4 });
  });

  it("names only registered widgets in every default layout", () => {
    for (const surface of DASHBOARD_SURFACES) {
      for (const persona of WIDGET_PERSONAS) {
        for (const entry of DEFAULT_LAYOUTS[surface][persona]) {
          const def = widgetById(entry.id);
          expect(def, `${surface}/${persona}: ${entry.id} is not registered`).toBeDefined();
          expect(def!.surface).toBe(surface);
        }
      }
    }
  });

  it("uses an allowed size, and a persona-appropriate widget, in every default", () => {
    for (const surface of DASHBOARD_SURFACES) {
      for (const persona of WIDGET_PERSONAS) {
        for (const entry of DEFAULT_LAYOUTS[surface][persona]) {
          const def = widgetById(entry.id)!;
          expect(def.sizes, `${entry.id} at ${entry.size}`).toContain(entry.size);
          expect(def.personas, `${entry.id} for ${persona}`).toContain(persona);
        }
      }
    }
  });

  it("never repeats a widget within one default layout", () => {
    for (const surface of DASHBOARD_SURFACES) {
      for (const persona of WIDGET_PERSONAS) {
        const ids = DEFAULT_LAYOUTS[surface][persona].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("returns a fresh copy from defaultLayoutFor so callers cannot edit the shipped default", () => {
    const first = defaultLayoutFor("grading", "seller");
    first[0]!.size = "sm";
    expect(defaultLayoutFor("grading", "seller")[0]?.size).toBe("lg");
  });

  it("splits the registry by surface", () => {
    for (const surface of DASHBOARD_SURFACES) {
      for (const widget of widgetsForSurface(surface)) {
        expect(widget.surface).toBe(surface);
      }
    }
    const counted = DASHBOARD_SURFACES.reduce(
      (n, s) => n + widgetsForSurface(s).length,
      0,
    );
    expect(counted).toBe(DASHBOARD_WIDGETS.length);
  });
});
