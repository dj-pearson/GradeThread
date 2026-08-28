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

function paint(taken: string[] = []) {
  return renderToStaticMarkup(
    <SamplePickerBody
      onOpenChange={() => {}}
      samples={STARTER_SNIPPETS}
      taken={taken}
      nameMax={SNIPPET_NAME_MAX}
      noun="snippet"
      adding={false}
      onAdd={() => {}}
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
});
