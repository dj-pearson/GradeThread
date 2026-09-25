// Pure helpers for listing templates (US-674): input validation/normalization
// for the CRUD route, and the deterministic overlay that applies a template to
// an AutoLister-generated listing draft. No DB/network here, so both are
// unit-tested directly (src/tests/listing-template_test.ts).

import { normalizeAspectMap } from "./aspect-reconcile.ts";
import type { DescriptionBlock, DescriptionBlockKey } from "./description-blocks.ts";

/**
 * The trailing rows the boilerplate must not jump.
 *
 * Named here rather than imported: the edge's `description-blocks.ts` has no
 * pinned-key export, because pinning is a rule about the composer's drag
 * handles and this is the only server-side code that needs to know the order.
 * The two reasons are still the composer's — `renderDescription` force-moves
 * `facts` last, and the credentials-refresh cron expects its block beside it.
 */
const TRAILING_KEYS: readonly DescriptionBlockKey[] = ["credentials", "facts"];

export const TEMPLATE_NAME_MAX = 80;
/** Footer text is copied into every AutoLister draft; keep it bounded. */
export const DESCRIPTION_TEMPLATE_MAX = 20000;
/** eBay rejects a condition description over 1000 characters at publish. */
export const CONDITION_NOTE_MAX = 1000;
/** eBay allows 45 item specifics per listing, 65 characters per name and value. */
export const SPECIFICS_MAX = 45;
export const SPECIFIC_NAME_MAX = 65;
export const SPECIFIC_VALUE_MAX = 65;
/** sort_order is an integer column; anything past this is a typo, not an order. */
export const SORT_ORDER_MAX = 100000;

/**
 * The condition values a template may store. The same list as
 * EBAY_CONDITION_VALUES in ai-listing.ts, copied rather than imported because
 * ai-listing.ts imports this module; listing-template_test.ts pins the two.
 */
export const TEMPLATE_CONDITION_VALUES: readonly string[] = [
  "NEW",
  "NEW_OTHER",
  "NEW_WITH_DEFECTS",
  "LIKE_NEW",
  "PRE_OWNED_EXCELLENT",
  "USED_EXCELLENT",
  "PRE_OWNED_FAIR",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
];

/** eBay category and business-policy ids are numeric strings. */
const EBAY_ID_RE = /^\d{1,20}$/;

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
function coerceSpecifics(
  v: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: true, value: {} };
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    let sv: string | null = null;
    if (typeof val === "string") {
      sv = val.trim() || null;
    } else if (typeof val === "number" || typeof val === "boolean") {
      sv = String(val);
    }
    if (sv === null) continue;
    if (key.length > SPECIFIC_NAME_MAX) {
      return {
        ok: false,
        error: `Item specific names must be ${SPECIFIC_NAME_MAX} characters or fewer`,
      };
    }
    if (sv.length > SPECIFIC_VALUE_MAX) {
      return {
        ok: false,
        error: `Item specific values must be ${SPECIFIC_VALUE_MAX} characters or fewer (${key})`,
      };
    }
    out[key] = sv;
  }
  if (Object.keys(out).length > SPECIFICS_MAX) {
    return { ok: false, error: `A template can hold at most ${SPECIFICS_MAX} item specifics` };
  }
  return { ok: true, value: out };
}

/**
 * Validate + normalize a create/update payload (snake_case wire shape, matching
 * the iOS EdgeAPI's convertToSnakeCase encoder). Name is required; every other
 * field is optional and trimmed-to-null when blank. Every free-text field is
 * capped here, because a template is copied into every draft it touches and a
 * value eBay will refuse should fail at save, not at publish.
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
  const description = trimOrNull(b.description_template);
  if (description && description.length > DESCRIPTION_TEMPLATE_MAX) {
    return {
      ok: false,
      error: `Footer text must be ${DESCRIPTION_TEMPLATE_MAX} characters or fewer`,
    };
  }
  const note = trimOrNull(b.condition_description);
  if (note && note.length > CONDITION_NOTE_MAX) {
    return {
      ok: false,
      error: `Condition note must be ${CONDITION_NOTE_MAX} characters or fewer`,
    };
  }
  const condition = trimOrNull(b.ebay_condition);
  if (condition && !TEMPLATE_CONDITION_VALUES.includes(condition)) {
    return { ok: false, error: "Condition is not a value eBay accepts" };
  }
  const ids: Record<string, string | null> = {};
  for (
    const [field, label] of [
      ["ebay_category_id", "Category id"],
      ["return_policy_id", "Return policy id"],
      ["shipping_policy_id", "Shipping policy id"],
      ["payment_policy_id", "Payment policy id"],
    ] as const
  ) {
    const v = trimOrNull(b[field]);
    if (v && !EBAY_ID_RE.test(v)) {
      return { ok: false, error: `${label} must be digits only` };
    }
    ids[field] = v;
  }
  const specifics = coerceSpecifics(b.item_specifics);
  if (!specifics.ok) return specifics;
  const rawSort = b.sort_order;
  const sort = typeof rawSort === "number" && Number.isFinite(rawSort)
    ? Math.min(SORT_ORDER_MAX, Math.max(0, Math.trunc(rawSort)))
    : 0;
  return {
    ok: true,
    value: {
      name,
      description_template: description,
      ebay_condition: condition,
      condition_description: note,
      item_specifics: specifics.value,
      ebay_category_id: ids.ebay_category_id,
      return_policy_id: ids.return_policy_id,
      shipping_policy_id: ids.shipping_policy_id,
      payment_policy_id: ids.payment_policy_id,
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
 * The template's boilerplate as a description block, or null when it has none.
 *
 * US-2967. This used to be appended straight onto `listings.listing_description`,
 * and that made it disposable: since the block epic (migration 00678) that
 * column is the RENDER OUTPUT, and `blocksForListing` returns
 * `description_blocks` whenever the row has any. So the boilerplate lived in a
 * string nothing derived it from, and the seller's first save in the composer
 * wrote it away — silently, on the listing they had just finished checking.
 *
 * `src: "seller"` because they wrote it. It is an ordinary editable `text`
 * block from then on: they can retype it, switch it off or drag it, and the
 * template stops having an opinion the moment it has been applied.
 */
export function templateTextBlock(
  template: Pick<ListingTemplateRow, "description_template">,
): DescriptionBlock | null {
  const boiler = template.description_template?.trim();
  if (!boiler) return null;
  return { key: "text", on: true, src: "seller", text: boiler };
}

/**
 * Insert the template's boilerplate into a block list, after the prose and in
 * front of the pinned rows.
 *
 * Position matters in one direction only: a plain append would drop the
 * seller's terms BETWEEN the credentials block and the item facts. Splicing in
 * front of the first TRAILING_KEYS row is, for a freshly generated draft,
 * exactly "at the end of what a human wrote".
 */
export function withTemplateBlock(
  blocks: DescriptionBlock[],
  template: Pick<ListingTemplateRow, "description_template">,
): DescriptionBlock[] {
  const block = templateTextBlock(template);
  if (!block) return blocks;
  const at = blocks.findIndex((b) => TRAILING_KEYS.includes(b.key));
  const out = blocks.slice();
  out.splice(at === -1 ? out.length : at, 0, block);
  return out;
}

/**
 * US-3476: overlay a template's specifics onto a draft's existing ones. The
 * draft keeps every aspect the template does not name; the template's value
 * wins on each aspect it does name (matched case-insensitively, stored under
 * the template's spelling).
 */
export function mergeTemplateSpecifics(
  existing: unknown,
  templateSpecifics: Record<string, unknown>,
): Record<string, string[]> {
  const base = existing && typeof existing === "object"
    ? normalizeAspectMap(existing as Record<string, unknown>)
    : {};
  const overlay = normalizeAspectMap(templateSpecifics);
  const out: Record<string, string[]> = {};
  const overlayKeys = new Set(Object.keys(overlay).map((k) => k.toLowerCase().trim()));
  for (const [name, values] of Object.entries(base)) {
    if (!overlayKeys.has(name.toLowerCase().trim())) out[name] = values;
  }
  for (const [name, values] of Object.entries(overlay)) out[name] = values;
  return out;
}

/**
 * Build the `listings` patch that applies a template to an AutoLister-generated
 * draft. Condition / category / specifics / policies are set only when the
 * template provides them, so a sparse template leaves the AI result intact.
 * Returns an empty object when the template adds nothing.
 *
 * US-2967: the description is NOT in here any more. It is a block, and blocks
 * are written by generation in the same upsert as the string they render to —
 * see `withTemplateBlock` above and `descriptionBlocks` in `generateListing`.
 * Patching the rendered column from out here would put the row back in the
 * state the block epic exists to prevent: a description not derived from its
 * blocks.
 */
export function buildTemplateListingPatch(
  template: ListingTemplateRow,
  current?: { item_specifics_override?: unknown } | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (template.ebay_condition) patch.ebay_condition = template.ebay_condition;
  if (template.condition_description) {
    patch.ebay_condition_description = template.condition_description;
  }
  if (
    template.item_specifics &&
    Object.keys(template.item_specifics).length > 0
  ) {
    // US-1505: persist item_specifics_override as string[] values (the shape
    // every edge publish/revise consumer expects), not the template's raw
    // {String:String}. normalizeAspectMap drops blank values too.
    //
    // US-3476: MERGE into what generation wrote, never replace it. The old
    // assignment dropped every AI-filled specific the template did not name,
    // so a template carrying one line ("Department: Women") left a draft with
    // one specific. The template still wins on the aspects it names.
    patch.item_specifics_override = mergeTemplateSpecifics(
      current?.item_specifics_override,
      template.item_specifics,
    );
  }
  // The listing's category lives in `platform_category_id` — that's what
  // assemblePublishContext reads (listing.platform_category_id ?? item.ebay_category_id).
  if (template.ebay_category_id) patch.platform_category_id = template.ebay_category_id;
  if (template.return_policy_id) patch.return_policy_id = template.return_policy_id;
  if (template.shipping_policy_id) {
    patch.shipping_policy_id = template.shipping_policy_id;
  }
  if (template.payment_policy_id) {
    patch.payment_policy_id = template.payment_policy_id;
  }

  return patch;
}
