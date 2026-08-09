// Every measurement group needs a description template, and every template
// needs the grade line.
//
// WHY THIS EXISTS. `DESCRIPTION_TEMPLATES` is keyed by MeasurementGroup, so
// TypeScript already forces a new group to have an entry — that half is safe.
// What TypeScript cannot see is the CONTENT: the templates are opaque strings,
// and `{{grade}}` is the placeholder that carries the GradeThread grade into
// the listing description. It is one of the three channels a grade reaches a
// buyer through (vault/30-platform/grade-authority-on-listings.md), and the
// only one a seller reads without clicking anything.
//
// So a new category added by someone copying a neighbouring template and
// trimming the fields they did not need would silently ship listings with no
// grade line at all — for that category only, which is exactly the shape that
// survives review. Two categories were added this way in one day (US-2225 bags,
// US-2224 accessories), which is when the risk became worth pinning.

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

  it("carries the grade placeholder in EVERY template", () => {
    // The one that matters. Dropping {{grade}} loses the grade line for that
    // category's listings and nothing else changes.
    for (const [group, tpl] of Object.entries(DESCRIPTION_TEMPLATES)) {
      expect(tpl, `${group} template must include {{grade}}`).toContain("{{grade}}");
    }
  });

  it("carries the measurements placeholder in every template", () => {
    // Same argument: a category with a measurement template but no
    // {{measurements}} asks the seller for numbers it then never publishes.
    for (const [group, tpl] of Object.entries(DESCRIPTION_TEMPLATES)) {
      expect(tpl, `${group} template must include {{measurements}}`)
        .toContain("{{measurements}}");
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
