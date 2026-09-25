import {
  APPAREL_CONDITION_LABELS,
  EBAY_CONDITION_ENUM_TO_ID,
  EBAY_CONDITION_OPTIONS,
} from "@/lib/constants";
import { conditionOverstatesGrade, mapGradeToApparelCondition } from "@/lib/ebay-prefill";

// "Preview on a graded item": what a template's fixed condition means next to
// the condition GradeThread's grade would pick for the same garment. A template
// that forces "Pre-owned - Excellent" is right for a 9.0 and a promise the
// certificate contradicts on a 6.0, and the seller should see that while they
// are writing the template rather than in a buyer's return request.

/** The sample grades shown: a near-new garment and a well-worn one. */
const PREVIEW_GRADES = [9.0, 6.0] as const;

/** What a clothing buyer reads for a condition value. */
function conditionLabel(value: string): string {
  const id = EBAY_CONDITION_ENUM_TO_ID[value];
  const apparel = id ? APPAREL_CONDITION_LABELS[id] : undefined;
  return apparel ?? EBAY_CONDITION_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export interface TemplateGradePreviewProps {
  ebayCondition: string;
  conditionDescription: string;
  descriptionTemplate: string;
}

export function TemplateGradePreview({
  ebayCondition,
  conditionDescription,
  descriptionTemplate,
}: TemplateGradePreviewProps) {
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Preview on a graded item
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <ul className="space-y-2">
          {PREVIEW_GRADES.map((grade) => {
            const byGrade = mapGradeToApparelCondition(grade);
            const clash = ebayCondition !== "" && conditionOverstatesGrade(ebayCondition, grade);
            return (
              <li key={grade} data-grade={grade.toFixed(1)}>
                <span className="font-medium">A {grade.toFixed(1)} garment: </span>
                {ebayCondition
                  ? `lists as ${conditionLabel(ebayCondition)} (fixed by this template).`
                  : `lists as ${conditionLabel(byGrade)}, picked from its grade.`}
                {clash && (
                  <p className="mt-0.5 text-destructive">
                    A {grade.toFixed(1)} would normally list as {conditionLabel(byGrade)}; this
                    template forces {conditionLabel(ebayCondition)}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {conditionDescription.trim() && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Condition note</p>
            <p className="whitespace-pre-wrap">{conditionDescription.trim()}</p>
          </div>
        )}
        {descriptionTemplate.trim() && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Footer, after the listing's own description
            </p>
            <p className="whitespace-pre-wrap">{descriptionTemplate.trim()}</p>
          </div>
        )}
      </div>
    </details>
  );
}
