// US-2966: the sample picker, rendered.
//
// renderToStaticMarkup is the repo's convention here (no @testing-library), so
// this asserts first paint: every sample's FULL body is on screen rather than a
// list of titles, and the confirm button is the disabled "nothing ticked" form.
// The renaming this dialog performs is covered directly in
// src/lib/starter-presets.test.ts, where the logic lives.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SamplePickerBody } from "@/components/flipdesk/sample-picker";
import { STARTER_SNIPPETS } from "@/lib/starter-snippets";
import { SNIPPET_NAME_MAX } from "@/lib/flipdesk-snippets";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";
import { TEMPLATE_NAME_MAX } from "@/lib/flipdesk-templates";

function paint(
  taken: string[] = [],
  extra: Partial<Parameters<typeof SamplePickerBody>[0]> = {},
) {
  return renderToStaticMarkup(
    <SamplePickerBody
      onOpenChange={() => {}}
      samples={STARTER_SNIPPETS}
      taken={taken}
      nameMax={SNIPPET_NAME_MAX}
      noun="snippet"
      adding={false}
      onAdd={() => {}}
      {...extra}
    />,
  );
}

describe("SamplePickerBody", () => {
  it("shows every sample's whole body, not just its name", () => {
    const html = paint();
    for (const s of STARTER_SNIPPETS) {
      expect(html).toContain(s.name);
      // The first clause of each body is enough to prove the text is present
      // and not summarised away.
      expect(html).toContain(s.body.split(".")[0]);
    }
  });

  it("offers the plural, unticked confirm label before anything is checked", () => {
    expect(paint()).toContain("Add snippets");
  });

  it("says how a partial add went, naming what did not save", () => {
    const html = paint([], {
      result: {
        total: 3,
        added: ["a", "c"],
        failed: [{ id: "b", name: "Returns", message: "It did not save." }],
      },
    });
    expect(html).toContain("Added 2 of 3.");
    expect(html).toContain("Returns did not save: It did not save.");
  });

  it("shows progress while adding", () => {
    const html = paint([], { adding: true, progress: { done: 1, total: 4 } });
    expect(html).toContain("Adding 2 of 4...");
  });

  it("shows each template starter's condition and buyer-facing condition note", () => {
    const html = renderToStaticMarkup(
      <SamplePickerBody
        onOpenChange={() => {}}
        samples={STARTER_TEMPLATES}
        taken={[]}
        nameMax={TEMPLATE_NAME_MAX}
        noun="template"
        adding={false}
        onAdd={() => {}}
        bodyLabel="Footer"
      />,
    );
    expect(html).toContain("Footer");
    for (const t of STARTER_TEMPLATES) {
      // renderToStaticMarkup escapes apostrophes.
      expect(html).toContain(t.conditionDescription.replace(/'/g, "&#x27;"));
      expect(html).toContain(t.note!.replace(/^Condition: /, ""));
      // The checkbox label is the name alone.
      expect(html).toMatch(new RegExp(`id="sample-${t.id}-name"[^>]*>${t.name}</label>`));
    }
  });
});
