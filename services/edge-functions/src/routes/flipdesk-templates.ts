// Listing templates CRUD (US-674). Mounted at /api/flipdesk/templates
// (authed + workspace context). Reusable presets — description boilerplate,
// item-specifics defaults, default condition, and shipping/return/payment
// business policies — that pre-fill the Publish composer and AutoLister drafts.
//
// Tenant safety (CLAUDE.md US-268): the service-role client bypasses RLS, so
// every query is scoped to the workspace owner. Update/delete are scoped by id
// AND user_id; an id from the request is never trusted alone.

import { type Context, Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { normalizeTemplateInput } from "../lib/listing-template.ts";

export const flipdeskTemplatesRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const TEMPLATE_COLUMNS =
  "id, name, description_template, ebay_condition, condition_description, " +
  "item_specifics, ebay_category_id, return_policy_id, shipping_policy_id, " +
  "payment_policy_id, is_default, sort_order, created_at, updated_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DbError = { code?: string; message?: string; details?: string | null } | null;

function isUniqueViolation(error: DbError): boolean {
  return error?.code === "23505";
}

/**
 * Two unique rules can fire on a template write, and they need different
 * answers. The name rule (listing_templates_user_id_name_key) is fixed by
 * renaming. The one-default index fires when another save made a different row
 * the default in between our clear and our set, and renaming cannot fix that.
 */
export function classifyUniqueViolation(
  error: DbError,
): "template_default_conflict" | "template_name_taken" {
  const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
  return text.includes("idx_listing_templates_one_default")
    ? "template_default_conflict"
    : "template_name_taken";
}

function conflict(c: Context, error: DbError): Response {
  return classifyUniqueViolation(error) === "template_default_conflict"
    ? jsonError(
      c,
      409,
      "Another template just became your default. Reload and try again.",
      "template_default_conflict",
    )
    : jsonError(c, 409, "A template with that name already exists", "template_name_taken");
}

/** Clear the owner's existing default so the one-default index holds. */
async function clearDefault(ownerId: string, exceptId: string): Promise<DbError> {
  const { error } = await supabaseAdmin
    .from("listing_templates")
    .update({ is_default: false })
    .eq("user_id", ownerId)
    .eq("is_default", true)
    .neq("id", exceptId);
  return error;
}

/**
 * Make `id` the owner's only default. Called only AFTER the row's own write
 * succeeded, so a 404 or a name clash can never clear the old default first
 * (US-1265, the bug 00317 fixed for the RPC path). There is still a window
 * between the clear and the set; closing it needs the deferred trigger with an
 * advisory lock, which is a migration and also covers the native RPC path.
 */
async function promoteDefault(
  c: Context,
  ownerId: string,
  id: string,
): Promise<{ row: Record<string, unknown> } | { res: Response }> {
  const clearErr = await clearDefault(ownerId, id);
  if (clearErr) {
    return { res: jsonError(c, 500, "Template saved, but it could not be made the default") };
  }
  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .update({ is_default: true })
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) return { res: conflict(c, error) };
    return { res: jsonError(c, 500, "Template saved, but it could not be made the default") };
  }
  if (!data) return { res: jsonError(c, 404, "Template not found") };
  // TEMPLATE_COLUMNS is a concatenated string, which supabase-js cannot parse
  // into a row type, so the row is typed by hand here.
  return { row: data as unknown as Record<string, unknown> };
}

// GET / — list the workspace owner's templates.
flipdeskTemplatesRoutes.get("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("user_id", ownerId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) return jsonError(c, 500, "Could not load templates");
  return c.json({ templates: data ?? [] });
});

// POST / — create a template.
flipdeskTemplatesRoutes.post("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeTemplateInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);

  const wantDefault = norm.value.is_default;

  // Insert as non-default first: a name clash must leave the old default alone.
  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .insert({ ...norm.value, is_default: false, user_id: ownerId })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error || !data) {
    if (isUniqueViolation(error)) return conflict(c, error);
    return jsonError(c, 500, "Could not create template");
  }
  if (!wantDefault) return c.json({ template: data }, 201);
  const newId = (data as unknown as { id: string }).id;
  const promoted = await promoteDefault(c, ownerId, newId);
  if ("res" in promoted) return promoted.res;
  return c.json({ template: promoted.row }, 201);
});

// PUT /:id — replace a template (full body; name required). Scoped to owner.
flipdeskTemplatesRoutes.put("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  // A malformed id answers exactly like a foreign one, and before any query:
  // a non-uuid would otherwise reach the uuid column and 500 on 22P02.
  if (!id || !UUID_RE.test(id)) return jsonError(c, 404, "Template not found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeTemplateInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);

  // Write every field but the default flag first, scoped by id AND user_id
  // (US-268). A 404 or a name clash returns here, before any default is
  // cleared. Turning the default OFF is safe to do in this same write.
  const { is_default: wantDefault, ...fields } = norm.value;
  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .update(wantDefault ? fields : { ...fields, is_default: false })
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) return conflict(c, error);
    return jsonError(c, 500, "Could not update template");
  }
  if (!data) return jsonError(c, 404, "Template not found");
  if (!wantDefault) return c.json({ template: data });
  const promoted = await promoteDefault(c, ownerId, id);
  if ("res" in promoted) return promoted.res;
  return c.json({ template: promoted.row });
});

// DELETE /:id — delete a template. Scoped to owner.
flipdeskTemplatesRoutes.delete("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return jsonError(c, 404, "Template not found");

  // Verify ownership before deleting (mirrors api-keys delete).
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("listing_templates")
    .select("id")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (fetchErr) return jsonError(c, 500, "Could not delete template");
  if (!existing) return jsonError(c, 404, "Template not found");

  const { error } = await supabaseAdmin
    .from("listing_templates")
    .delete()
    .eq("id", id)
    .eq("user_id", ownerId);
  if (error) return jsonError(c, 500, "Could not delete template");
  return c.json({ ok: true });
});
