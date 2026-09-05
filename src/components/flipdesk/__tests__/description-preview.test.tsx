// US-3114: the preview you can click.
//
// Rendered through createRoot + act — the repo's convention when the thing under
// test is interaction rather than first paint (see use-description-blocks.test).
// There is no @testing-library here.
//
// The rule these guard: a region is editable when, and only when, there is
// somewhere for the edit to go. Prose has a block that stores it. An attributes
// or measurements line has a field behind it. The grade, the disclosure, the
// credentials and the facts table have neither, and a click on one of those
// opening an empty editor would be a promise the composer cannot keep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DescriptionPreview } from "@/components/flipdesk/composer/description-preview";
import type { DescriptionSegment } from "@/types/database";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SEGMENTS: DescriptionSegment[] = [
  {
    index: 0,
    key: "intro",
    src: "ai",
    sep: "",
    body: "Veronica Beard jogger pants, new with tags.",
    kind: "text",
    lines: [{ text: "Veronica Beard jogger pants, new with tags." }],
  },
  {
    index: 1,
    key: "attributes",
    src: "item",
    sep: "\n\n",
    body: "- Brand: Veronica Beard\n- Size: 8",
    kind: "text",
    lines: [
      { text: "- Brand: Veronica Beard", field: "brand" },
      { text: "- Size: 8", field: "size" },
    ],
  },
  {
    index: 2,
    key: "measurements",
    src: "item",
    sep: "\n\n",
    body:
      "<!--gradethread-measurements-->\nMeasurements (garment laid flat):\n- Waist: 15 in\n<!--/gradethread-measurements-->",
    kind: "text",
    lines: [
      { text: "<!--gradethread-measurements-->", hidden: true },
      { text: "Measurements (garment laid flat):" },
      { text: "- Waist: 15 in", field: "waist" },
      { text: "<!--/gradethread-measurements-->", hidden: true },
    ],
  },
  {
    index: 3,
    key: "grade",
    src: "grade",
    sep: "\n\n",
    body: "Graded by GradeThread — Condition Grade 8.5",
    kind: "text",
    lines: [{ text: "Graded by GradeThread — Condition Grade 8.5" }],
  },
  {
    index: 4,
    key: "facts",
    src: "system",
    sep: "\n\n",
    body: "<!--gradethread-facts--><ul><li>Grade 8.5</li></ul><!--/gradethread-facts-->",
    kind: "html",
    html: "<ul><li>Grade 8.5</li></ul>",
  },
];

const RAW = SEGMENTS.map((s) => s.sep + s.body).join("");

let host: HTMLDivElement;
let root: Root;

function mount(props: Partial<React.ComponentProps<typeof DescriptionPreview>> = {}) {
  const merged: React.ComponentProps<typeof DescriptionPreview> = {
    segments: SEGMENTS,
    preview: RAW,
    pending: false,
    available: true,
    proseText: () => "Veronica Beard jogger pants, new with tags.",
    onProseChange: () => {},
    attributeValues: { brand: "Veronica Beard", size: "8" },
    measurementValues: { waist: 15 },
    onDerivedCommit: async () => {},
    onGoToField: () => {},
    disabled: false,
    ...props,
  };
  act(() => {
    root.render(h(DescriptionPreview, merged));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Set a controlled input's value the way React's synthetic layer expects. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

function byLabel(label: string): HTMLElement | null {
  return host.querySelector(`[aria-label="${label}"]`);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("AC5: what renders as markup, and what does not", () => {
  it("renders one region per segment", () => {
    mount();
    expect(byLabel("Intro section")).not.toBeNull();
    expect(byLabel("Attributes section")).not.toBeNull();
    expect(byLabel("Measurements section")).not.toBeNull();
    expect(byLabel("Grade badge section")).not.toBeNull();
    expect(byLabel("Item facts section")).not.toBeNull();
  });

  it("renders GradeThread markup as markup", () => {
    mount();
    const facts = byLabel("Item facts section");
    expect(facts?.querySelector("ul li")?.textContent).toBe("Grade 8.5");
  });

  it("shows prose as text, never as markup", () => {
    mount({
      segments: [{ ...SEGMENTS[0]!, body: "<b>bold claim</b>" }],
      proseText: () => "<b>bold claim</b>",
    });
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain("<b>bold claim</b>");
  });

  it("hides the comment markers but keeps the header line", () => {
    mount();
    const block = byLabel("Measurements section");
    expect(block?.textContent).not.toContain("<!--");
    expect(block?.textContent).toContain("Measurements (garment laid flat):");
  });
});

describe("AC6: clicking prose opens an editor for that block", () => {
  it("opens a textarea and reports edits against the segment's block index", () => {
    const onProseChange = vi.fn();
    mount({ onProseChange });

    expect(byLabel("Intro text")).toBeNull();
    click(byLabel("Edit Intro")!);
    const editor = byLabel("Intro text") as HTMLTextAreaElement;
    expect(editor).not.toBeNull();

    type(editor, "Rewritten opener.");
    expect(onProseChange).toHaveBeenCalledWith(0, "Rewritten opener.");
  });

  it("closes on Escape without another edit", () => {
    const onProseChange = vi.fn();
    mount({ onProseChange });
    click(byLabel("Edit Intro")!);
    key(byLabel("Intro text")!, "Escape");
    expect(byLabel("Intro text")).toBeNull();
    expect(onProseChange).not.toHaveBeenCalled();
  });

  it("offers no editor at all when the listing is eBay-owned", () => {
    mount({ disabled: true });
    click(byLabel("Edit Intro")!);
    expect(byLabel("Intro text")).toBeNull();
  });
});

describe("AC7: clicking a generated line edits the field behind it", () => {
  it("prefills from the item value and commits on Enter", async () => {
    const onDerivedCommit = vi.fn(async () => {});
    mount({ onDerivedCommit });

    click(byLabel("Edit brand")!);
    const input = byLabel("brand value") as HTMLInputElement;
    expect(input.value).toBe("Veronica Beard");

    type(input, "Veronica Beard Denim");
    key(input, "Enter");
    await act(async () => {});
    expect(onDerivedCommit).toHaveBeenCalledWith(
      "attributes",
      "brand",
      "Veronica Beard Denim",
    );
  });

  it("commits a measurement against its key, not its label", async () => {
    const onDerivedCommit = vi.fn(async () => {});
    mount({ onDerivedCommit });

    click(byLabel("Edit waist")!);
    const input = byLabel("waist value") as HTMLInputElement;
    expect(input.value).toBe("15");
    type(input, "16");
    key(input, "Enter");
    await act(async () => {});
    expect(onDerivedCommit).toHaveBeenCalledWith("measurements", "waist", "16");
  });

  it("writes nothing when the value is unchanged", async () => {
    const onDerivedCommit = vi.fn(async () => {});
    mount({ onDerivedCommit });
    click(byLabel("Edit brand")!);
    key(byLabel("brand value")!, "Enter");
    await act(async () => {});
    expect(onDerivedCommit).not.toHaveBeenCalled();
  });

  it("abandons the edit on Escape", async () => {
    const onDerivedCommit = vi.fn(async () => {});
    mount({ onDerivedCommit });
    click(byLabel("Edit brand")!);
    type(byLabel("brand value") as HTMLInputElement, "Something else");
    key(byLabel("brand value")!, "Escape");
    await act(async () => {});
    expect(onDerivedCommit).not.toHaveBeenCalled();
    expect(byLabel("brand value")).toBeNull();
  });
});

describe("AC8: the blocks with nothing behind them are read-only", () => {
  it("offers no editor on the grade line or the facts table", () => {
    mount();
    const grade = byLabel("Grade badge section")!;
    const facts = byLabel("Item facts section")!;
    for (const region of [grade, facts]) {
      expect(region.querySelector("textarea")).toBeNull();
      expect(region.querySelector("input")).toBeNull();
      // The only control either may carry is the jump to its source fields.
      for (const btn of region.querySelectorAll("button")) {
        expect(btn.getAttribute("aria-label")).toMatch(/^Go to the /);
      }
    }
  });

  it("offers no editor on the measurements header line", () => {
    mount();
    const region = byLabel("Measurements section")!;
    const labels = [...region.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toContain("Edit waist");
    expect(labels).not.toContain("Edit undefined");
  });
});

describe("AC9: the raw view", () => {
  it("swaps to the exact bytes and back", () => {
    mount();
    expect(byLabel("Rendered description preview")).toBeNull();
    click([...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Show raw",
    )!);
    const box = byLabel("Rendered description preview") as HTMLTextAreaElement;
    expect(box.value).toBe(RAW);
  });

  it("falls back to the raw view when the edge sends no segments", () => {
    mount({ segments: [] });
    const box = byLabel("Rendered description preview") as HTMLTextAreaElement;
    expect(box.value).toBe(RAW);
    // No toggle either — there is nothing to toggle to.
    expect(
      [...host.querySelectorAll("button")].some((b) => b.textContent === "Show raw"),
    ).toBe(false);
  });

  it("says so when the listing has no row to render against", () => {
    mount({ available: false });
    expect(host.textContent).toContain("Save the draft once");
  });
});
