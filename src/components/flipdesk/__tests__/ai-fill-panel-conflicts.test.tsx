// US-1530: conflicts[] must actually SURFACE — an inline "pick one" section
// per conflicted field — and conflicted fields must never appear among the
// auto-apply suggestion rows.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ConflictPicker } from "@/components/flipdesk/ai-fill-panel";

const CONFLICTS = [
  { field: "size", text_value: "M", photo_value: "8" },
  { field: "brand", text_value: "Lululemon", photo_value: "Lulu Lemon" },
];

describe("ConflictPicker (US-1530)", () => {
  it("renders a warning header and one pick-one card per conflicted field", () => {
    const html = renderToStaticMarkup(
      <ConflictPicker
        conflicts={CONFLICTS}
        picks={{}}
        fieldLabels={{}}
        onPick={() => {}}
      />
    );
    expect(html).toContain("Conflicting values — pick one");
    expect(html).toContain("Size");
    expect(html).toContain("Brand");
    // Both candidate values render so the user chooses deliberately.
    expect(html).toContain("From photo");
    expect(html).toContain("From text");
    expect(html).toContain(">M<");
    expect(html).toContain(">8<");
  });

  it("marks the picked candidate and honors custom field labels", () => {
    const html = renderToStaticMarkup(
      <ConflictPicker
        conflicts={[CONFLICTS[0]!]}
        picks={{ size: "text" }}
        fieldLabels={{ size: "Garment Size" }}
        onPick={() => {}}
      />
    );
    expect(html).toContain("Garment Size");
    // The picked (text) button carries the selected border class.
    const textIdx = html.indexOf("From text");
    const selectedIdx = html.lastIndexOf("border-primary", textIdx);
    expect(selectedIdx).toBeGreaterThan(-1);
  });

  it("renders nothing when there are no conflicts", () => {
    const html = renderToStaticMarkup(
      <ConflictPicker conflicts={[]} picks={{}} fieldLabels={{}} onPick={() => {}} />
    );
    expect(html).toBe("");
  });
});
