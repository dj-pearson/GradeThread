// Every measurement group needs a description template, and no template may
// restate a fact a description block owns.
//
// WHY THIS EXISTS. `DESCRIPTION_TEMPLATES` is keyed by MeasurementGroup, so
// TypeScript already forces a new group to have an entry — that half is safe.
// What TypeScript cannot see is the CONTENT: the templates are opaque strings,
// and a new category added by someone copying a neighbouring template and
// trimming the fields they did not need ships wrong listings for that category
// only, which is exactly the shape that survives review. Two categories were
// added this way in one day (US-2225 bags, US-2224 accessories), which is when
// the risk became worth pinning.
//
// US-2965 INVERTED TWO OF THESE CASES. They used to require `{{grade}}` and
// `{{measurements}}` in every template, because the template WAS the whole
// description. It is not any more: a template fills the `intro` block, and the
// grade, the disclosure and the measurement table are their own blocks that the
// edge renderer emits on every save (migration 00678). A template that still
// carried those placeholders printed each fact twice, and only one of the two
// copies followed the seller's next edit — the duplicate-fact failure the block
// epic exists to remove. The grade still reaches the buyer; it reaches them
// through the `grade` and `disclosure` blocks
// (vault/30-platform/grade-authority-on-listings.md) rather than through here.

import { describe, expect, it } from "vitest";
import { DESCRIPTION_TEMPLATES } from "../lib/listing-templates";
import { MEASUREMENT_TEMPLATES } from "../lib/measurement-templates";

const GROUPS = Object.keys(MEASUREMENT_TEMPLATES);

describe("listing description templates", () => {
  it("covers every measurement group", () => {
    // Belt and braces against the type: a Record<MeasurementGroup, string>
    // built with a cast, or a group added to one file and not the other, would
    // slip past tsc.
    expect(Object.keys(DESCRIPTION_TEMPLATES).sort()).toEqual([...GROUPS].sort());
  });

  it("restates NO fact a description block already owns", () => {
    // The one that matters now. A template fills the `intro` block, and the
    // renderer emits the grade, the disclosure and the measurement table as
    // their own blocks after it — so a placeholder here is a second copy of a
    // fact, not a missing one. `interpolateDescription` no longer fills either,
    // which means a placeholder left behind renders as a blank gap rather than
    // as a duplicate; both are wrong, and this is the cheap place to catch it.
    for (const [group, tpl] of Object.entries(DESCRIPTION_TEMPLATES)) {
      expect(tpl, `${group} template must not restate the grade`)
        .not.toContain("{{grade}}");
      expect(tpl, `${group} template must not restate the measurements`)
        .not.toContain("{{measurements}}");
      // The headings went with the placeholders. A bare "Measurements:" over
      // nothing is the same bug wearing the label instead of the values.
      expect(tpl, `${group} template must not carry a measurements heading`)
        .not.toContain("Measurements");
      expect(tpl, `${group} template must not carry a grade line`)
        .not.toContain("Condition Grade");
    }
  });

  it("still fills the fields the intro block is FOR", () => {
    // The inversion above is only safe while the template keeps doing its own
    // job: the opening line and the seller-visible attributes. A template
    // trimmed to nothing would pass every "must not contain" assertion.
    for (const [group, tpl] of Object.entries(DESCRIPTION_TEMPLATES)) {
      expect(tpl, `${group} template must open with the brand and title`)
        .toContain("{{brand}} {{title}}");
      expect(tpl, `${group} template must carry the condition line`)
        .toContain("Condition: {{condition}}");
    }
  });

  it("only asks for a size where the category has one", () => {
    // A bag and a tie have no size — their dimensions ARE the size — so a
    // "Size: " line renders as an empty field on every listing in the category.
    for (const group of ["bag", "accessory", "watch"]) {
      expect(DESCRIPTION_TEMPLATES[group as keyof typeof DESCRIPTION_TEMPLATES])
        .not.toContain("Size:");
    }
    // And it still asks where the category does have one.
    expect(DESCRIPTION_TEMPLATES.top).toContain("Size:");
  });
});
