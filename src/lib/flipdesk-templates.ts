import { edgeFetch } from "@/lib/edge-fetch";
import {
  APPAREL_CONDITION_LABELS,
  EBAY_CONDITION_ENUM_TO_ID,
  EBAY_CONDITION_OPTIONS,
} from "@/lib/constants";

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
/**
 * The rest of the edge's caps, mirrored the same way and pinned by
 * listing-templates-web-parity.test.ts. The server refuses a longer value with
 * a 400; the editor uses these to warn before that happens.
 */
export const DESCRIPTION_TEMPLATE_MAX = 20000;
/** eBay's own limit on a condition description. */
export const CONDITION_NOTE_MAX = 1000;
export const SPECIFICS_MAX = 45;
export const SPECIFIC_NAME_MAX = 65;
export const SPECIFIC_VALUE_MAX = 65;
export const SORT_ORDER_MAX = 100000;

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

/**
 * An API failure, carrying the edge's `code` when it sent one. The two 409s a
 * save can hit need different advice: a name clash is fixed by renaming, a
 * default clash (another save made a different row the default meanwhile) by
 * reloading.
 */
export class TemplateApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "TemplateApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Why a name clashes with another template on the account, or null.
 *
 * Trimmed and case-insensitive: the database's unique rule is case-sensitive,
 * but "Denim" and "denim" read as the same template in every picker, so the
 * editor refuses the second one before the server is asked.
 */
export function duplicateNameProblem(
  name: string,
  templates: readonly Pick<ListingTemplate, "id" | "name">[],
  existingId: string | null,
): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const clash = templates.find(
    (t) => t.id !== existingId && t.name.trim().toLowerCase() === want,
  );
  return clash ? `You already have a template called "${clash.name}". Pick a different name.` : null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await edgeFetch(path, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = json as { error?: string; code?: string };
    throw new TemplateApiError(
      body.error || "That did not save. Try again.",
      res.status,
      typeof body.code === "string" ? body.code : null,
    );
  }
  return json as T;
}

/** What a failed save should tell the seller to do next, by the edge's code. */
export function saveErrorNextStep(err: unknown): string | undefined {
  const code = err instanceof TemplateApiError ? err.code : null;
  if (code === "template_name_taken") return "That name is taken. Pick a different one.";
  if (code === "template_default_conflict") {
    return "Another template just became your default. Reload and try again.";
  }
  return undefined;
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

/**
 * What a clothing buyer reads for a template's condition. Apparel label first:
 * USED_EXCELLENT (3000) is "Pre-owned - Good" in a clothing leaf, and the
 * starter picker, the grade preview and publish all say so. The generic list's
 * "Pre-owned - Excellent" for it would contradict all three.
 */
export function templateConditionLabel(value: string): string {
  const id = EBAY_CONDITION_ENUM_TO_ID[value];
  const apparel = id ? APPAREL_CONDITION_LABELS[id] : undefined;
  return apparel ?? EBAY_CONDITION_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/**
 * The editor's condition list when eBay has not narrowed it to a category:
 * the shared list, with USED_EXCELLENT relabelled to what a clothing buyer sees
 * for it, so it does not read as a second "Excellent".
 */
export const TEMPLATE_CONDITION_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  EBAY_CONDITION_OPTIONS.map((o) =>
    o.value === "USED_EXCELLENT" ? { ...o, label: "Pre-owned - Good (apparel)" } : o,
  );

/** One thing a template sets, as a chip on its list row. */
export interface TemplateChip {
  label: string;
  /** "warn" for a partial set of policies: one or two of three is usually a slip. */
  tone?: "warn";
}

/**
 * What a template actually does, one chip per field it sets. An empty list
 * means the template carries nothing. The condition note counts: a template
 * holding only a note used to read "Empty".
 */
export function templateChips(t: ListingTemplate): TemplateChip[] {
  const chips: TemplateChip[] = [];
  if (t.ebay_condition) {
    chips.push({ label: templateConditionLabel(t.ebay_condition) });
  }
  if (t.condition_description) chips.push({ label: "Condition note" });
  if (t.description_template) chips.push({ label: "Footer" });
  if (t.ebay_category_id) chips.push({ label: `Category ${t.ebay_category_id}` });
  const specifics = Object.keys(t.item_specifics ?? {}).length;
  if (specifics > 0) chips.push({ label: `${specifics} detail${specifics === 1 ? "" : "s"}` });
  const policies = [t.shipping_policy_id, t.payment_policy_id, t.return_policy_id].filter(
    Boolean,
  ).length;
  if (policies > 0) {
    chips.push({
      label: `${policies} of 3 policies`,
      tone: policies < 3 ? "warn" : undefined,
    });
  }
  return chips;
}

/** The next free sort_order: one past the highest, so new rows sort last. */
export function nextSortOrder(templates: readonly Pick<ListingTemplate, "sort_order">[]): number {
  const max = templates.reduce((m, t) => Math.max(m, t.sort_order), -1);
  return Math.min(SORT_ORDER_MAX, max + 1);
}

/** The starter fields `addStarterTemplates` saves. */
export interface StarterTemplateSource {
  id: string;
  body: string;
  ebayCondition: string;
  conditionDescription: string;
}

/** How a batch of sample adds went: every pick is either added or failed. */
export interface SampleAddResult {
  total: number;
  /** Sample ids that saved. */
  added: string[];
  failed: Array<{ id: string; name: string; message: string }>;
}

/**
 * Save each picked starter as the seller's own row, one at a time.
 *
 * Sequential because each row needs its own sort_order. It never stops half
 * way: a pick that fails is recorded and the next one is still tried, so the
 * seller is told exactly which ones did not save rather than getting one error
 * for a batch that nonetheless wrote rows.
 */
export async function addStarterTemplates(
  picks: ReadonlyArray<{ sample: { id: string }; name: string }>,
  starters: readonly StarterTemplateSource[],
  startOrder: number,
  onProgress?: (done: number, total: number) => void,
  create: (input: TemplateInput) => Promise<ListingTemplate> = createTemplate,
): Promise<SampleAddResult> {
  const result: SampleAddResult = { total: picks.length, added: [], failed: [] };
  let order = startOrder;
  let done = 0;
  for (const { sample, name } of picks) {
    onProgress?.(done, picks.length);
    const starter = starters.find((t) => t.id === sample.id);
    if (!starter) {
      result.failed.push({ id: sample.id, name, message: "That sample no longer exists." });
    } else {
      try {
        await create({
          name,
          description_template: starter.body,
          ebay_condition: starter.ebayCondition,
          condition_description: starter.conditionDescription,
          // No item specifics and no policy ids: those are the seller's own
          // eBay account values, and no starter can guess them. Nor is_default
          // -- picking a favourite stays their call.
          item_specifics: {},
          is_default: false,
          sort_order: order,
        });
        order += 1;
        result.added.push(sample.id);
      } catch (err) {
        result.failed.push({
          id: sample.id,
          name,
          message: err instanceof Error ? err.message : "It did not save.",
        });
      }
    }
    done += 1;
  }
  onProgress?.(done, picks.length);
  return result;
}


/**
 * What is wrong with each item-details row, keyed by the row's key.
 *
 * A half-filled row used to vanish on save without a word, and two rows with
 * the same name (in any case) collapsed into one. Both are now problems the
 * editor shows on the row and blocks Save on. Fully blank rows are fine: they
 * are dropped, which is what the seller expects of an empty line.
 */
export function specificRowProblems(
  rows: ReadonlyArray<{ key: string; name: string; value: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.trim();
    const value = r.value.trim();
    if (!name && !value) continue;
    if (name && !value) {
      out.set(r.key, "Add a value or remove this row.");
      continue;
    }
    if (!name && value) {
      out.set(r.key, "Add a name or remove this row.");
      continue;
    }
    const k = name.toLowerCase();
    const first = seen.get(k);
    if (first !== undefined) {
      out.set(r.key, `"${name}" is already a detail above. Use one row per name.`);
    } else {
      seen.set(k, r.key);
    }
  }
  return out;
}

/** A stored row as a full update body, for PUTs that change one thing. */
export function templateToInput(t: ListingTemplate): TemplateInput {
  return {
    name: t.name,
    description_template: t.description_template,
    ebay_condition: t.ebay_condition,
    condition_description: t.condition_description,
    item_specifics: { ...(t.item_specifics ?? {}) },
    ebay_category_id: t.ebay_category_id,
    return_policy_id: t.return_policy_id,
    shipping_policy_id: t.shipping_policy_id,
    payment_policy_id: t.payment_policy_id,
    is_default: t.is_default,
    sort_order: t.sort_order,
  };
}

/**
 * The confirm text for deleting `t`. Deleting the default says which template
 * takes over, because `preferredTemplate` falls back to the first remaining
 * row rather than to nothing.
 */
export function deleteConfirmText(
  t: ListingTemplate,
  templates: readonly ListingTemplate[],
): string {
  const base =
    "Listings you already made with it keep everything it filled in. " +
    "You just will not be able to apply it again.";
  if (!t.is_default) return base;
  const next = preferredTemplate(templates.filter((x) => x.id !== t.id));
  return next
    ? `${base} This is your default. After it is gone, AutoLister and Publish will start with "${next.name}" instead.`
    : `${base} This is your default and your only template, so AutoLister and Publish will start with no template.`;
}
