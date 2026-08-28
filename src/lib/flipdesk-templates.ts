import { edgeFetch } from "@/lib/edge-fetch";

// US-2877. Saved listing templates, on the web.
//
// The table (`listing_templates`, US-674) and the CRUD API
// (/api/flipdesk/templates) have existed since 2025. iOS has had a full
// editor since then. The web had ONE reader -- a dropdown in the AutoLister
// bulk grid -- with its own private copy of the row type, and no way to make,
// change or delete a template at all. So a seller could apply a preset on the
// desktop and could only BUILD one on a phone, which is the wrong way round:
// the presets are paragraphs of boilerplate, and people write on keyboards.
//
// NAMING, because two different things in this repo are called templates:
//   * src/lib/listing-templates.ts   DESCRIPTION_TEMPLATES -- our hardcoded
//     per-garment description boilerplate. Not the seller's, not stored.
//   * this file                      the seller's own saved presets, one row
//     each in `listing_templates`.
// The composer applies the first and, until this story, knew nothing about the
// second.

/**
 * A saved template, exactly as the API returns it.
 *
 * snake_case on purpose: this is the wire shape, and renaming it here would
 * make three places (this, the edge's `NormalizedTemplate`, and the iOS
 * `CodingKeys`) disagree about what a field is called.
 */
export interface ListingTemplate {
  id: string;
  name: string;
  description_template: string | null;
  ebay_condition: string | null;
  /**
   * The condition NOTE, which the bulk grid's private copy of this type left
   * out entirely. A template written on iOS with a condition note lost it the
   * moment the web read the row.
   */
  condition_description: string | null;
  /**
   * `Record<string, string>` -- ONE value per aspect, which is what the server
   * normalizes to (`coerceSpecifics` in the edge's listing-template.ts) and
   * what iOS decodes. The bulk grid typed it `string[] | string` and branched
   * on `Array.isArray`, which was defensive against a shape the API cannot
   * return.
   */
  item_specifics: Record<string, string>;
  ebay_category_id: string | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  is_default: boolean;
  sort_order: number;
}

/** What create/update send. Everything but the name is optional. */
export interface TemplateInput {
  name: string;
  description_template?: string | null;
  ebay_condition?: string | null;
  condition_description?: string | null;
  item_specifics?: Record<string, string>;
  ebay_category_id?: string | null;
  return_policy_id?: string | null;
  shipping_policy_id?: string | null;
  payment_policy_id?: string | null;
  is_default?: boolean;
  sort_order?: number;
}

/** Mirrors TEMPLATE_NAME_MAX in the edge's listing-template.ts. */
export const TEMPLATE_NAME_MAX = 80;

/** The one query key, so a mutation anywhere refreshes every reader. */
export const TEMPLATES_QUERY_KEY = ["flipdesk_listing_templates"] as const;

/**
 * Trim, drop blanks, and turn "" into null the same way the server does.
 *
 * Run before sending rather than trusting the server to tidy up, so what the
 * editor thinks it saved and what comes back are the same values. The server
 * still normalizes -- this is not a substitute for that, it is the client
 * agreeing with it.
 */
export function normalizeInput(input: TemplateInput): TemplateInput {
  const t = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    return s.length === 0 ? null : s;
  };
  const specifics: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.item_specifics ?? {})) {
    const key = k.trim();
    const val = (v ?? "").trim();
    if (key && val) specifics[key] = val;
  }
  return {
    name: input.name.trim(),
    description_template: t(input.description_template),
    ebay_condition: t(input.ebay_condition),
    condition_description: t(input.condition_description),
    item_specifics: specifics,
    ebay_category_id: t(input.ebay_category_id),
    return_policy_id: t(input.return_policy_id),
    shipping_policy_id: t(input.shipping_policy_id),
    payment_policy_id: t(input.payment_policy_id),
    is_default: input.is_default ?? false,
    sort_order: input.sort_order ?? 0,
  };
}

/** Why a name is not savable, or null when it is. */
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return "Give the template a name so you can find it later.";
  if (t.length > TEMPLATE_NAME_MAX) {
    return `Names are ${TEMPLATE_NAME_MAX} characters or fewer. This one is ${t.length}.`;
  }
  return null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await edgeFetch(path, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error || "That did not save. Try again.",
    );
  }
  return json as T;
}

export async function listTemplates(): Promise<ListingTemplate[]> {
  const json = await call<{ templates?: ListingTemplate[] }>(
    "/api/flipdesk/templates",
  );
  return json.templates ?? [];
}

export async function createTemplate(input: TemplateInput): Promise<ListingTemplate> {
  const json = await call<{ template: ListingTemplate }>("/api/flipdesk/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalizeInput(input)),
  });
  return json.template;
}

export async function updateTemplate(
  id: string,
  input: TemplateInput,
): Promise<ListingTemplate> {
  const json = await call<{ template: ListingTemplate }>(
    `/api/flipdesk/templates/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizeInput(input)),
    },
  );
  return json.template;
}

export async function deleteTemplate(id: string): Promise<void> {
  await call(`/api/flipdesk/templates/${id}`, { method: "DELETE" });
}

/** The template a client should offer first: the default, else the first row. */
export function preferredTemplate(
  templates: readonly ListingTemplate[],
): ListingTemplate | null {
  return templates.find((t) => t.is_default) ?? templates[0] ?? null;
}

/** One field a template would change, and what it would change it to. */
export interface TemplateFieldChange {
  /** The composer state key this lands on. */
  field: string;
  /** What the seller calls it. */
  label: string;
  value: string;
  /** True when the field already has something in it. */
  wouldOverwrite: boolean;
}

/**
 * What applying `t` would do to a listing that currently holds `current`.
 *
 * FILL-EMPTY, never overwrite -- the same rule the AutoLister bulk grid has
 * used since US-555. A preset exists to save typing, and a preset that wipes
 * the sentence somebody just wrote costs more than it saves. The
 * `wouldOverwrite` flag is here so a caller can SAY that a field was left
 * alone rather than silently skipping it, which is how "the template did
 * nothing" gets reported as a bug.
 *
 * The description is the one exception, and has been since US-2967: it APPENDS
 * as its own block instead of replacing a value, so there is nothing for it to
 * wipe and no reason to skip it.
 */
export function templateChanges(
  t: ListingTemplate,
  current: Readonly<Record<string, string>>,
): TemplateFieldChange[] {
  const out: TemplateFieldChange[] = [];
  const add = (
    field: string,
    label: string,
    value: string | null,
    appends = false,
  ) => {
    if (!value) return;
    out.push({
      field,
      label,
      value,
      // An appending field can never overwrite, so it is never skipped. Before
      // US-2967 the description was treated like the rest, which meant the one
      // field a seller most wants from a preset was dropped on every listing
      // that already had a description — i.e. every generated draft.
      wouldOverwrite: appends
        ? false
        : (current[field] ?? "").trim().length > 0,
    });
  };
  add("ebayCondition", "Condition", t.ebay_condition);
  add("conditionDescription", "Condition note", t.condition_description);
  add("description", "Description footer", t.description_template, true);
  add("categoryId", "eBay category", t.ebay_category_id);
  add("shippingPolicyId", "Shipping policy", t.shipping_policy_id);
  add("paymentPolicyId", "Payment policy", t.payment_policy_id);
  add("returnPolicyId", "Return policy", t.return_policy_id);
  return out;
}

/** A one-line summary of what a template carries, for the list row. */
export function templateSummary(t: ListingTemplate): string {
  const parts: string[] = [];
  if (t.description_template) parts.push("description");
  if (t.ebay_condition) parts.push("condition");
  if (t.ebay_category_id) parts.push("category");
  const specifics = Object.keys(t.item_specifics ?? {}).length;
  if (specifics > 0) parts.push(`${specifics} item detail${specifics === 1 ? "" : "s"}`);
  const policies = [t.shipping_policy_id, t.payment_policy_id, t.return_policy_id].filter(
    Boolean,
  ).length;
  if (policies > 0) parts.push(`${policies} polic${policies === 1 ? "y" : "ies"}`);
  if (parts.length === 0) return "Empty. Nothing in it to apply yet.";
  return `Sets ${parts.join(", ")}.`;
}
