import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WidgetCatalog,
  WidgetEditControls,
} from "@/components/dashboard/customize-board";
import { addableWidgets } from "@/lib/dashboard-layout";
import {
  defaultLayoutFor,
  widgetsForSurface,
  type LayoutEntry,
  type WidgetDef,
} from "@/lib/dashboard-widgets";

// US-3074 AC2 and AC3, asserted on the markup rather than on the functions
// behind it. Both claims are about what a person can reach: a control that
// exists but is not labelled with its widget is four identical "Hide" buttons
// to a screen reader, and a catalog that filters correctly but renders the
// wrong list is still a buyer being offered FlipDesk.

const registry = widgetsForSurface("grading");
const sellerBoard = defaultLayoutFor("grading", "seller");

function usageDef(): WidgetDef {
  const def = registry.find((w) => w.id === "grading.usage");
  if (!def) throw new Error("grading.usage left the registry");
  return def;
}

function chartsDef(): WidgetDef {
  const def = registry.find((w) => w.id === "grading.charts");
  if (!def) throw new Error("grading.charts left the registry");
  return def;
}

/**
 * The one opening tag carrying `aria-label`. React writes attributes in JSX
 * order, so a slice around the label would sometimes miss the class list; this
 * finds the whole tag instead.
 */
function tagFor(html: string, label: string): string {
  const tag = html
    .split("<")
    .find((chunk) => chunk.includes(`aria-label="${label}"`));
  if (!tag) throw new Error(`no element labelled "${label}"`);
  return tag;
}

function renderControls(def: WidgetDef, overrides?: Partial<{ isFirst: boolean; isLast: boolean }>) {
  const entry: LayoutEntry = sellerBoard.find((e) => e.id === def.id) ?? {
    id: def.id,
    size: def.defaultSize,
  };
  return renderToStaticMarkup(
    <WidgetEditControls
      def={def}
      entry={entry}
      isFirst={overrides?.isFirst ?? false}
      isLast={overrides?.isLast ?? false}
      onResize={() => {}}
      onHide={() => {}}
      onMove={() => {}}
    />,
  );
}

// A registry with FlipDesk widgets in it, because the shipped one has none yet
// (US-3076 fills that surface) and the rule has to hold before they land.
const MIXED_REGISTRY: WidgetDef[] = [
  {
    id: "flipdesk.sales",
    surface: "flipdesk",
    title: "Sales this month",
    blurb: "What sold and for how much.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: true,
    personas: ["seller", "consignment"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
  {
    id: "grading.impact",
    surface: "grading",
    title: "Circularity impact",
    blurb: "What reselling kept out of landfill.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller", "buyer"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
];

describe("the frame controls in Customize mode", () => {
  it("names the widget in every control's aria-label", () => {
    const html = renderControls(usageDef());
    expect(html).toContain('aria-label="Reorder Plan usage"');
    expect(html).toContain('aria-label="Hide Plan usage"');
    expect(html).toContain('aria-label="Move Plan usage up"');
    expect(html).toContain('aria-label="Move Plan usage down"');
    expect(html).toContain('aria-label="Size of Plan usage"');
  });

  it("offers only the sizes the widget declares", () => {
    // grading.usage is legible at md and lg, never sm.
    const html = renderControls(usageDef());
    expect(html).toContain('aria-label="Set Plan usage to medium"');
    expect(html).toContain('aria-label="Set Plan usage to full width"');
    expect(html).not.toContain('aria-label="Set Plan usage to small"');
  });

  it("marks the current size as the pressed one", () => {
    // The seller default puts grading.usage at lg.
    const html = renderControls(usageDef());
    expect(tagFor(html, "Set Plan usage to full width")).toContain(
      'aria-pressed="true"',
    );
    expect(tagFor(html, "Set Plan usage to medium")).toContain(
      'aria-pressed="false"',
    );
  });

  it("renders no size control for a widget with one allowed size", () => {
    // grading.charts is full width only; a select that cannot change anything
    // is a control that teaches the seller it is broken.
    const html = renderControls(chartsDef());
    expect(html).not.toContain('aria-label="Size of Grade trends"');
    expect(html).toContain('aria-label="Hide Grade trends"');
  });

  it("renders every control as a real button, so all of them are tabbable", () => {
    const html = renderControls(usageDef());
    // Four icon controls plus the select trigger; none is a bare div.
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("disables move-up on the first widget and move-down on the last", () => {
    expect(
      tagFor(renderControls(usageDef(), { isFirst: true }), "Move Plan usage up"),
    ).toContain('disabled=""');
    expect(
      tagFor(renderControls(usageDef(), { isLast: true }), "Move Plan usage down"),
    ).toContain('disabled=""');
    // and are live otherwise
    expect(tagFor(renderControls(usageDef()), "Move Plan usage up")).not.toContain(
      'disabled=""',
    );
  });

  // AC2: below sm the arrows REPLACE the drag handle, so the two are mutually
  // exclusive by breakpoint rather than stacked.
  it("shows the arrows only below sm and the grip only at sm and up", () => {
    const html = renderControls(usageDef());
    expect(tagFor(html, "Move Plan usage up")).toContain("sm:hidden");
    expect(tagFor(html, "Move Plan usage down")).toContain("sm:hidden");
    const grip = tagFor(html, "Reorder Plan usage");
    expect(grip).toContain("hidden ");
    expect(grip).toContain("sm:inline-flex");
  });
});

describe("the Add-widget catalog", () => {
  it("groups by category with a title and a blurb for each widget", () => {
    const html = renderToStaticMarkup(
      <WidgetCatalog
        widgets={addableWidgets([], MIXED_REGISTRY, "seller")}
        onAdd={() => {}}
      />,
    );
    expect(html).toContain("Your numbers");
    expect(html).toContain("Sales this month");
    expect(html).toContain("What sold and for how much.");
    expect(html).toContain('aria-label="Add Sales this month to your board"');
  });

  // AC3: the claim is about the sheet, not only about the function behind it.
  it("never renders a flipdesk widget for a buyer", () => {
    const html = renderToStaticMarkup(
      <WidgetCatalog
        widgets={addableWidgets([], MIXED_REGISTRY, "buyer")}
        onAdd={() => {}}
      />,
    );
    expect(html).not.toContain("Sales this month");
    expect(html).toContain("Circularity impact");
  });

  it("says so rather than rendering an empty sheet", () => {
    const html = renderToStaticMarkup(
      <WidgetCatalog widgets={[]} onAdd={() => {}} />,
    );
    expect(html).toContain("already on your board");
  });
});
