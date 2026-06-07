// Pure helpers for listing templates (US-674): input validation/normalization
// for the CRUD route, and the deterministic overlay that applies a template to
// an AutoLister-generated listing draft. No DB/network here, so both are
// unit-tested directly (src/tests/listing-template_test.ts).

export const TEMPLATE_NAME_MAX = 80;

/** DB-column shape the route inserts/updates (snake_case mirrors the table). */
export interface NormalizedTemplate {
  name: string;
  description_template: string | null;
  ebay_condition: string | null;
  condition_description: string | null;
  item_specifics: Record<string, string>;
  ebay_category_id: string | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  is_default: boolean;
  sort_order: number;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedTemplate }
  | { ok: false; error: string };

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** Coerce an item-specifics map to { string: string }, dropping empties. */
function coerceSpecifics(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof val === "string") {
      const sv = val.trim();
      if (sv) out[key] = sv;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = String(val);
    }
  }
  return out;
}

/**
 * Validate + normalize a create/update payload (snake_case wire shape, matching
 * the iOS EdgeAPI's convertToSnakeCase encoder). Name is required; every other
 * field is optional and trimmed-to-null when blank.
 */
export function normalizeTemplateInput(body: unknown): NormalizeResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid template payload" };
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Template name is required" };
  if (name.length > TEMPLATE_NAME_MAX) {
    return {
      ok: false,
      error: `Template name must be ${TEMPLATE_NAME_MAX} characters or fewer`,
    };
  }
  const rawSort = b.sort_order;
  const sort = typeof rawSort === "number" && Number.isFinite(rawSort)
    ? Math.trunc(rawSort)
    : 0;
  return {
    ok: true,
    value: {
      name,
      description_template: trimOrNull(b.description_template),
      ebay_condition: trimOrNull(b.ebay_condition),
      condition_description: trimOrNull(b.condition_description),
      item_specifics: coerceSpecifics(b.item_specifics),
      ebay_category_id: trimOrNull(b.ebay_category_id),
      return_policy_id: trimOrNull(b.return_policy_id),
      shipping_policy_id: trimOrNull(b.shipping_policy_id),
      payment_policy_id: trimOrNull(b.payment_policy_id),
      is_default: b.is_default === true,
      sort_order: sort,
    },
  };
}

/** The subset of a template row the overlay applies to a draft. */
export interface ListingTemplateRow {
  description_template: string | null;
  ebay_condition: string | null;
  condition_description: string | null;
  item_specifics: Record<string, unknown> | null;
  ebay_category_id: string | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
}

/**
 * Build the `listings` patch that applies a template to an AutoLister-generated
 * draft. The AI-written description leads; the template's boilerplate is
 * APPENDED (never clobbered). Condition / category / specifics / policies are
 * set only when the template provides them, so a sparse template leaves the AI
 * result intact. Returns an empty object when the template adds nothing.
 */
export function buildTemplateListingPatch(
  template: ListingTemplateRow,
  currentDescription: string | null | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const boiler = template.description_template?.trim();
  if (boiler) {
    const base = (currentDescription ?? "").trimEnd();
    patch.listing_description = base.length > 0 ? `${base}\n\n${boiler}` : boiler;
  }
  if (template.ebay_condition) patch.ebay_condition = template.ebay_condition;
  if (template.condition_description) {
    patch.ebay_condition_description = template.condition_description;
  }
  if (
    template.item_specifics &&
    Object.keys(template.item_specifics).length > 0
  ) {
    patch.item_specifics_override = template.item_specifics;
  }
  if (template.ebay_category_id) patch.ebay_category_id = template.ebay_category_id;
  if (template.return_policy_id) patch.return_policy_id = template.return_policy_id;
  if (template.shipping_policy_id) {
    patch.shipping_policy_id = template.shipping_policy_id;
  }
  if (template.payment_policy_id) {
    patch.payment_policy_id = template.payment_policy_id;
  }

  return patch;
}
