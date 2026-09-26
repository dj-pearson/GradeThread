// US-3538 AC2: does each photo show the view it was uploaded as?
//
// The duplicate guard (duplicate-photo-guard.ts) stops the same photo in two
// core slots. It does not stop a seller putting a back shot in the front slot,
// a close-up in the label slot, or a different garment in one slot. The
// per-image call already looks at every photo, so this asks it one more
// question: `matches_declared_view`, true when the photo actually shows the
// view it was uploaded as.
//
// This changes the model's output schema, so it ships through the
// grading-engine lifecycle: behind GRADING_VIEW_CHECK, default OFF. Off, the
// schema text, the rules text and the structured-output schema are untouched
// (byte-identical). On, all three gain the field, the per-image read is stamped
// "+view" and the grade suffix gains "+view" (appended last). A front, back or
// label photo answering false blocks the grade with a retake ask through the
// image-quality gate. Shadow, eval and canary with the flag on before it is on
// for everyone.
//
// Pure: no supabase.

export function viewCheckEnabled(): boolean {
  const v = (Deno.env.get("GRADING_VIEW_CHECK") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Core slots whose view is checked. Detail and measurement shots are not. */
export const VIEW_CHECKED_SLOTS = ["front", "back", "label"] as const;

const SCHEMA_ANCHOR = '\n  "quality": {';
const SCHEMA_FIELD = '\n  "matches_declared_view": true | false,';
const RULES_ANCHOR = "\n- Be precise and objective.";
export const VIEW_CHECK_RULE =
  "\n- matches_declared_view: this photo was uploaded as the image type named above. " +
  "Set true if it actually shows that view of the garment (front: the front of the whole garment; " +
  "back: the back of the whole garment; label: a brand, size or care label or tag; any other " +
  "type: set true). Set false if it shows a different view, a different garment, or no garment. " +
  "Judge the view only; condition, lighting and blur do not matter here.";

/**
 * Add the field to the schema text and the rule to the rules text. `applied`
 * only when BOTH anchors were found, so a block override that dropped either
 * is left alone and is not mislabelled as the "+view" era.
 */
export function applyViewCheckWording(
  schemaText: string,
  rulesText: string,
  enabled: boolean = viewCheckEnabled(),
): { schemaText: string; rulesText: string; applied: boolean } {
  if (!enabled || !schemaText.includes(SCHEMA_ANCHOR) || !rulesText.includes(RULES_ANCHOR)) {
    return { schemaText, rulesText, applied: false };
  }
  return {
    schemaText: schemaText.replace(SCHEMA_ANCHOR, `${SCHEMA_FIELD}${SCHEMA_ANCHOR}`),
    rulesText: rulesText.replace(RULES_ANCHOR, `${VIEW_CHECK_RULE}${RULES_ANCHOR}`),
    applied: true,
  };
}

/** The structured-output schema with the field required. A new object. */
export function outputSchemaWithViewCheck(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  return {
    ...schema,
    properties: { ...props, matches_declared_view: { type: "boolean" } },
    required: [...required, "matches_declared_view"],
  };
}

/** A strict boolean or null. Anything else reads as "not asked". */
export function parseMatchesDeclaredView(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/** Core slots whose photo answered false. Null (not asked) never blocks. */
export function viewMismatchSlots(
  analyses: ReadonlyArray<{ image_type: string; matches_declared_view?: boolean | null }>,
): string[] {
  return analyses
    .filter((a) =>
      (VIEW_CHECKED_SLOTS as readonly string[]).includes(a.image_type) &&
      a.matches_declared_view === false
    )
    .map((a) => a.image_type);
}
