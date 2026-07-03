import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { captureException } from "../lib/observability.ts";
import {
  bustSettingCache,
  coerceSettingValue,
  type SettingValueType,
  type SystemSettingRow,
} from "../lib/system-settings.ts";
import { requireScope } from "../lib/scope-guard.ts";

// DB-backed system settings registry — admin editor API (US-884).
//
// Mounted at /api/admin/settings — inherits authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
// GET  /            — every setting, grouped by category, for the editor.
// PUT  /:key        — update one value (type-validated); super_admin + fresh MFA
//                     step-up; audited (before/after); busts the read cache so
//                     the change lands on the next request.
//
// The table is service-role only (RLS deny-all for clients) — these handlers are
// the only read/write path, role-gated at this API layer.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSettingsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminSettingsRoutes.use("*", requireScope("ops:write"));

const SELECT_COLS =
  "key, value, value_type, default_value, description, category, updated_at, updated_by";

interface SettingDto {
  key: string;
  value: unknown;
  value_type: SettingValueType;
  default_value: unknown;
  description: string | null;
  category: string;
  updated_at: string;
  updated_by: string | null;
}

interface CategoryGroup {
  category: string;
  settings: SettingDto[];
}

function toDto(row: SystemSettingRow): SettingDto {
  return {
    key: row.key,
    value: row.value,
    value_type: row.value_type,
    default_value: row.default_value,
    description: row.description,
    category: row.category,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

// GET / — all settings, grouped by category (categories + keys alpha-sorted for
// a stable editor layout).
adminSettingsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("system_settings")
    .select(SELECT_COLS)
    .order("category", { ascending: true })
    .order("key", { ascending: true });

  if (error) {
    captureException(error, { tags: { area: "admin-settings" } });
    return c.json({ error: "Failed to load settings" }, 500);
  }

  const rows = (data ?? []) as SystemSettingRow[];
  const byCategory = new Map<string, SettingDto[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(toDto(row));
    byCategory.set(row.category, list);
  }

  const groups: CategoryGroup[] = [...byCategory.entries()].map(
    ([category, settings]) => ({ category, settings }),
  );

  return c.json({ groups, total: rows.length });
});

// PUT /:key — update one setting. super_admin + fresh MFA step-up; type-validated
// against the row's value_type; audited; cache busted.
adminSettingsRoutes.put("/:key", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const key = c.req.param("key");
  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  if (!("value" in body)) {
    return c.json({ error: "Request body must include a 'value'." }, 400);
  }

  // Load the row first — we need its value_type to validate, and its prior value
  // for the audit trail. A missing key is a 404 (settings are seeded, never
  // created from the UI).
  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("system_settings")
    .select(SELECT_COLS)
    .eq("key", key)
    .maybeSingle();
  if (loadErr) {
    captureException(loadErr, { tags: { area: "admin-settings" } });
    return c.json({ error: "Failed to load setting" }, 500);
  }
  if (!existing) {
    return c.json({ error: "Unknown setting" }, 404);
  }
  const row = existing as SystemSettingRow;

  const coerced = coerceSettingValue(row.value_type, body.value);
  if (!coerced.ok) {
    return c.json({ error: coerced.error }, 400);
  }

  const adminId = c.get("userId");
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("system_settings")
    .update({ value: coerced.value, updated_by: adminId })
    .eq("key", key)
    .select(SELECT_COLS)
    .maybeSingle();
  if (updErr || !updated) {
    captureException(updErr ?? new Error("update returned no row"), {
      tags: { area: "admin-settings" },
    });
    return c.json({ error: "Failed to update setting" }, 500);
  }

  // Land the change immediately (don't wait out the TTL on this replica).
  bustSettingCache(key);

  await writeAuditLog(c, {
    action: "system_setting.update",
    targetType: "system_setting",
    targetId: key,
    before: row.value,
    after: coerced.value,
    details: { value_type: row.value_type, category: row.category },
  });

  return c.json({ ok: true, setting: toDto(updated as SystemSettingRow) });
});
