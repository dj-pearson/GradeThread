// The grade-aware template preview: a fixed condition that promises more than
// the grade is flagged, one that undersells it is not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplateGradePreview } from "@/components/flipdesk/template-grade-preview";
import {
  APPAREL_CONDITION_BANDS,
  conditionOverstatesGrade,
  mapGradeToApparelCondition,
} from "@/lib/ebay-prefill";

function paint(ebayCondition: string, note = "", footer = "") {
  return renderToStaticMarkup(
    <TemplateGradePreview
      ebayCondition={ebayCondition}
      conditionDescription={note}
      descriptionTemplate={footer}
    />,
  );
}

function row(html: string, grade: string): string {
  const start = html.indexOf(`data-grade="${grade}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</li>", start));
}

describe("TemplateGradePreview", () => {
  it("flags Pre-owned - Excellent on a 6.0 and not on a 9.0", () => {
    const html = paint("PRE_OWNED_EXCELLENT");
    expect(row(html, "9.0")).not.toContain("would normally list as");
    expect(row(html, "6.0")).toContain(
      "A 6.0 would normally list as Pre-owned - Good; this template forces Pre-owned - Excellent.",
    );
  });

  it("a template with no condition says the grade picks it", () => {
    const html = paint("");
    expect(row(html, "9.0")).toContain("New without tags, picked from its grade");
    expect(row(html, "6.0")).toContain("Pre-owned - Good, picked from its grade");
    expect(html).not.toContain("would normally list as");
  });

  it("shows the note and footer as they would read", () => {
    const html = paint("USED_EXCELLENT", "Light wear.", "Ships in one day.");
    expect(html).toContain("Light wear.");
    expect(html).toContain("Ships in one day.");
  });
});

describe("conditionOverstatesGrade", () => {
  it("compares legacy values by meaning, not by conditionId", () => {
    // Legacy Very good (4000) sits in the same band as Pre-owned - Good (3000),
    // so on a 6.0 it is not an overstatement even though 4000 > 3010.
    expect(conditionOverstatesGrade("USED_VERY_GOOD", 6.0)).toBe(false);
    expect(conditionOverstatesGrade("LIKE_NEW", 6.0)).toBe(true);
    expect(conditionOverstatesGrade("PRE_OWNED_FAIR", 9.0)).toBe(false);
    expect(conditionOverstatesGrade("NEW", 9.0)).toBe(true);
  });
});

describe("the web's apparel bands are the edge's", () => {
  it("every band number matches publish-preflight.ts", () => {
    const src = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/publish-preflight.ts"),
      "utf8",
    );
    for (const [k, v] of Object.entries(APPAREL_CONDITION_BANDS)) {
      const m = src.match(new RegExp(`${k}: ([\\d.]+),`));
      expect(m, `${k} is gone from the edge`).not.toBeNull();
      expect(v).toBe(Number(m![1]));
    }
  });

  it("maps the band edges the same way", () => {
    expect(mapGradeToApparelCondition(9.75)).toBe("NEW");
    expect(mapGradeToApparelCondition(9.0)).toBe("NEW_OTHER");
    expect(mapGradeToApparelCondition(7.5)).toBe("PRE_OWNED_EXCELLENT");
    expect(mapGradeToApparelCondition(5.0)).toBe("USED_EXCELLENT");
    expect(mapGradeToApparelCondition(4.9)).toBe("PRE_OWNED_FAIR");
  });
});
