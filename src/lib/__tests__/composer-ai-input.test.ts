// US-2817: what the composer sends for "Complete with AI" vs "Re-run AI".
// The failure this pins is silent: a re-run that still sends known_fields gets
// a 200, spends an AI action, and returns suggestions for nothing at all,
// because the route drops every suggestion for a field the caller named.

import { describe, expect, it } from "vitest";
import { buildComposerAiInput } from "@/lib/composer-ai-input";

const PARTS = {
  title: "Nike Windrunner Jacket Mens L",
  description: "Classic Nike windbreaker, navy.",
  conditionNotes: "Small mark on the left cuff.",
  fields: [
    { key: "brand", value: "Nike" },
    { key: "size", value: "L" },
    { key: "color", value: "" },
    { key: "material", value: null },
  ],
  photoCount: 4,
};

describe("buildComposerAiInput", () => {
  it("gap-fill sends every filled field as known", () => {
    const { known } = buildComposerAiInput(PARTS, "gap_fill");
    expect(known).toEqual({ brand: "Nike", size: "L" });
  });

  it("gap-fill sends the full text block", () => {
    const { text } = buildComposerAiInput(PARTS, "gap_fill");
    expect(text).toBe(
      "Nike Windrunner Jacket Mens L\nClassic Nike windbreaker, navy.\nSmall mark on the left cuff.",
    );
  });

  it("re-identify sends NO known fields, so every field can come back", () => {
    const { known } = buildComposerAiInput(PARTS, "reidentify");
    expect(known).toEqual({});
  });

  it("re-identify withholds generated copy when there are photos", () => {
    const { text } = buildComposerAiInput(PARTS, "reidentify");
    expect(text).toBe("Small mark on the left cuff.");
    expect(text).not.toContain("Nike");
  });

  it("re-identify keeps the text when there are no photos to read instead", () => {
    const { text } = buildComposerAiInput(
      { ...PARTS, photoCount: 0 },
      "reidentify",
    );
    expect(text).toContain("Nike Windrunner Jacket Mens L");
  });

  it("blank chunks never leave stray newlines in the prompt", () => {
    const { text } = buildComposerAiInput(
      { ...PARTS, description: "   ", conditionNotes: "" },
      "gap_fill",
    );
    expect(text).toBe("Nike Windrunner Jacket Mens L");
  });
});
