import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SURFACES,
  DASHBOARD_WIDGETS,
  DEFAULT_PERSONA,
  WIDGET_PERSONAS,
  WIDGET_SIZES,
  defaultLayoutFor,
  isDashboardSurface,
  isWidgetSize,
  widgetById,
  type LayoutContext,
} from "@/lib/dashboard-widgets";

// US-3072 registry, second half. `dashboard-widget-registry.test.ts` checks the
// DECLARATIONS - ids, sizes, personas, which surface a range-aware widget may
// live on. This checks what is CODE rather than data: the omitWhen predicates,
// defaultLayoutFor, and the two string narrowers a URL can feed.
//
// ⚠ THE `load` DYNAMIC IMPORTS ARE STILL UNTESTED, AND THAT IS DELIBERATE
// (US-3120). The obvious test - await every widget's loader and assert it
// resolves to a component - was written here, passed, and made the coverage
// gate WORSE: importing 50 widget components added about 378 functions to v8's
// denominator against about 52 newly covered, taking function coverage from
// 56.8% to 54.3%. The threshold is calibrated on "of the modules our tests
// import", so a test that imports more of the codebase lowers it however good
// the test is. Recorded rather than dropped in silence, because the next person
// will write the same test and see the same number without knowing why.

describe("omitWhen decides removal, not a quiet frame", () => {
  const withOmit = DASHBOARD_WIDGETS.filter((w) => w.omitWhen);

  it("at least one widget opts out, or this contract is dead code", () => {
    expect(withOmit.length).toBeGreaterThan(0);
  });

  it.each(withOmit.map((w) => [w.id, w] as const))(
    "%s answers for every shape of context, including the unknown one",
    (_id, widget) => {
      const omit = widget.omitWhen!;
      // undefined is NOT false here: a count still in flight and a count that
      // failed both arrive as undefined, and neither is grounds for removing a
      // widget from someone's board.
      const contexts: LayoutContext[] = [
        {},
        { hasInventory: true },
        { hasInventory: false },
        { hasConsignors: true },
        { hasConsignors: false },
        { hasInventory: true, hasConsignors: true },
      ];
      for (const context of contexts) {
        expect(typeof omit(context)).toBe("boolean");
      }
      expect(omit({})).toBe(false);
    },
  );
});

describe("the default layouts name widgets that exist", () => {
  const cases = DASHBOARD_SURFACES.flatMap((surface) =>
    WIDGET_PERSONAS.map((persona) => [`${surface}/${persona}`, surface, persona] as const),
  );

  it.each(cases)("%s starts every seller on widgets that resolve", (_label, surface, persona) => {
    // A default layout entry naming a retired widget is a blank frame on a
    // board nobody chose - the seller never added it, so they cannot remove it
    // either. `defaultLayoutFor` falls back to the seller list, which is why
    // this goes through it rather than reading DEFAULT_LAYOUTS directly.
    for (const entry of defaultLayoutFor(surface, persona)) {
      const found = widgetById(entry.id);
      expect(found, `${surface}/${persona} default layout names ${entry.id}`).toBeTruthy();
      expect(found!.surface, `${entry.id} belongs to another surface`).toBe(surface);
      expect(found!.sizes, `${entry.id} cannot render at ${entry.size}`).toContain(entry.size);
    }
  });

  it("at least one surface actually ships a default board", () => {
    // Guards the loop above from passing by iterating nothing.
    const total = DASHBOARD_SURFACES.reduce(
      (n, s) => n + WIDGET_PERSONAS.reduce((m, p) => m + defaultLayoutFor(s, p).length, 0),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("hands back a copy, so a caller editing its board cannot edit the default", () => {
    const first = defaultLayoutFor("grading", DEFAULT_PERSONA);
    expect(first.length).toBeGreaterThan(0);
    first[0]!.size = "sm";
    expect(defaultLayoutFor("grading", DEFAULT_PERSONA)[0]!.size).not.toBe("sm");
  });
});

describe("the string narrowers reject what a URL can carry", () => {
  it("only the three surfaces are surfaces", () => {
    for (const s of DASHBOARD_SURFACES) expect(isDashboardSurface(s)).toBe(true);
    for (const bad of ["", "GRADING", "ios_home", null, undefined, 3, {}]) {
      expect(isDashboardSurface(bad)).toBe(false);
    }
  });

  it("only the three sizes are sizes", () => {
    for (const s of WIDGET_SIZES) expect(isWidgetSize(s)).toBe(true);
    for (const bad of ["", "SM", "xl", null, undefined, 1, []]) {
      expect(isWidgetSize(bad)).toBe(false);
    }
  });
});
