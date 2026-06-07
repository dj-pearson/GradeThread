// Listing templates CRUD (US-674). Mounted at /api/flipdesk/templates
// (authed + workspace context). Reusable presets — description boilerplate,
// item-specifics defaults, default condition, and shipping/return/payment
// business policies — that pre-fill the Publish composer and AutoLister drafts.
//
// Tenant safety (CLAUDE.md US-268): the service-role client bypasses RLS, so
// every query is scoped to the workspace owner. Update/delete are scoped by id
// AND user_id; an id from the request is never trusted alone.

import { Hono } from "hono";
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

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

/** Clear the owner's existing default so the partial-unique index holds. */
async function clearDefault(ownerId: string, exceptId?: string): Promise<void> {
  let q = supabaseAdmin
    .from("listing_templates")
    .update({ is_default: false })
    .eq("user_id", ownerId)
    .eq("is_default", true);
  if (exceptId) q = q.neq("id", exceptId);
  await q;
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

  if (norm.value.is_default) await clearDefault(ownerId);

  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .insert({ ...norm.value, user_id: ownerId })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error || !data) {
    if (isUniqueViolation(error)) {
      return jsonError(c, 409, "A template with that name already exists");
    }
    return jsonError(c, 500, "Could not create template");
  }
  return c.json({ template: data }, 201);
});

// PUT /:id — replace a template (full body; name required). Scoped to owner.
flipdeskTemplatesRoutes.put("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  if (!id) return jsonError(c, 400, "Template id is required");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeTemplateInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);

  if (norm.value.is_default) await clearDefault(ownerId, id);

  // Scoped by id AND user_id — never trust the id alone (US-268).
  const { data, error } = await supabaseAdmin
    .from("listing_templates")
    .update(norm.value)
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) {
      return jsonError(c, 409, "A template with that name already exists");
    }
    return jsonError(c, 500, "Could not update template");
  }
  if (!data) return jsonError(c, 404, "Template not found");
  return c.json({ template: data });
});

// DELETE /:id — delete a template. Scoped to owner.
flipdeskTemplatesRoutes.delete("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  if (!id) return jsonError(c, 400, "Template id is required");

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
