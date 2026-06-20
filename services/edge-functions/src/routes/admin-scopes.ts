// Admin RBAC scope management (US-908).
//
// Mounted at /api/admin/scopes (inherits authMiddleware + adminAuthMiddleware
// incl. the AAL2/MFA gate from the /api/admin/* group in main.ts). Lets an
// operator view/edit which permission scopes each role holds, and grant extra
// scopes to a SPECIFIC admin without changing their role.
//
// Reads are admin. Every mutation is super_admin + the users:role scope + a
// fresh MFA step-up + audited (admin_audit_log) — editing who-can-do-what is as
// sensitive as a role grant. super_admin is implicit-all (never stored in
// role_scopes) and is not editable here.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { clearScopeCache, requireScope } from "../lib/scope-guard.ts";
import {
  effectiveScopes,
  isScopeKey,
  PERMISSION_SCOPES,
  type ScopeKey,
  SCOPE_KEYS,
  type UserRole,
} from "../lib/rbac-scopes.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminScopesRoutes = new Hono<AdminEnv>();

// Roles whose scopes are editable here. super_admin is implicit-all (omitted);
// `user` is included so an operator can explicitly see/keep it empty.
const EDITABLE_ROLES: UserRole[] = ["user", "reviewer", "admin"];

// Read the current role→scopes mapping straight from the DB (not the cached
// guard map) so the editor always shows live state.
async function loadRoleScopeMap(): Promise<Partial<Record<UserRole, ScopeKey[]>>> {
  const { data, error } = await supabaseAdmin
    .from("role_scopes")
    .select("role, scope_key");
  if (error) throw new Error(error.message);
  const map: Partial<Record<UserRole, ScopeKey[]>> = {};
  for (const r of (data ?? []) as Array<{ role: string; scope_key: string }>) {
    if (!isScopeKey(r.scope_key)) continue;
    (map[r.role as UserRole] ??= []).push(r.scope_key);
  }
  return map;
}

// Parse + validate a { scopes: string[] } body into a deduped ScopeKey[].
function parseScopes(body: unknown): { ok: true; scopes: ScopeKey[] } | { ok: false; error: string } {
  const raw = (body as { scopes?: unknown })?.scopes;
  if (!Array.isArray(raw)) return { ok: false, error: "`scopes` (string[]) is required" };
  const out = new Set<ScopeKey>();
  for (const s of raw) {
    if (!isScopeKey(s)) return { ok: false, error: `Unknown scope: ${String(s)}` };
    out.add(s);
  }
  return { ok: true, scopes: SCOPE_KEYS.filter((k) => out.has(k)) };
}

// ── GET /scopes — catalog + per-role mapping (admin read) ────────────────────
adminScopesRoutes.get("/", async (c) => {
  let roleMap: Record<string, ScopeKey[]>;
  try {
    roleMap = await loadRoleScopeMap();
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
  const roles = [
    // super_admin is implicit-all + read-only (can't be locked out of anything).
    { role: "super_admin", editable: false, scopes: [...SCOPE_KEYS] },
    ...EDITABLE_ROLES.map((role) => ({
      role,
      editable: true,
      scopes: effectiveScopes(role, roleMap),
    })),
  ];
  return c.json({ scopes: PERMISSION_SCOPES, roles });
});

// ── PUT /scopes/roles/:role — set the scopes a role holds ────────────────────
// super_admin + users:role scope + fresh step-up + audited.
adminScopesRoutes.put("/roles/:role", requireScope("users:role"), async (c: Context<AdminEnv>) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const role = c.req.param("role") as UserRole;
  if (!EDITABLE_ROLES.includes(role)) {
    return c.json({ error: "That role's scopes cannot be edited here." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = parseScopes(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  let before: ScopeKey[] = [];
  try {
    before = (await loadRoleScopeMap())[role] ?? [];
  } catch { /* best-effort before-snapshot */ }

  // Replace the role's scope set: delete then insert the new set.
  const { error: delErr } = await supabaseAdmin
    .from("role_scopes")
    .delete()
    .eq("role", role);
  if (delErr) return c.json({ error: delErr.message }, 500);

  if (parsed.scopes.length > 0) {
    const { error: insErr } = await supabaseAdmin
      .from("role_scopes")
      .insert(parsed.scopes.map((scope_key) => ({ role, scope_key })));
    if (insErr) return c.json({ error: insErr.message }, 500);
  }

  clearScopeCache();
  await writeAuditLog(c, {
    action: "admin.role_scopes_update",
    targetType: "role",
    targetId: null,
    details: { role, before, after: parsed.scopes },
  });

  return c.json({ ok: true, role, scopes: parsed.scopes });
});

// ── GET /scopes/users/:id — a specific admin's effective scopes + grants ─────
adminScopesRoutes.get("/users/:id", async (c) => {
  const targetId = c.req.param("id");
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("id, email, role")
    .eq("id", targetId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!user) return c.json({ error: "User not found" }, 404);

  const role = (user as { role: string }).role as UserRole;
  const { data: grantRows } = await supabaseAdmin
    .from("admin_scope_grants")
    .select("scope_key")
    .eq("admin_user_id", targetId);
  const grants = ((grantRows ?? []) as Array<{ scope_key: string }>)
    .map((r) => r.scope_key)
    .filter(isScopeKey);

  let roleMap: Record<string, ScopeKey[]>;
  try {
    roleMap = await loadRoleScopeMap();
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }

  return c.json({
    user: { id: (user as { id: string }).id, email: (user as { email: string }).email, role },
    role_scopes: effectiveScopes(role, roleMap),
    granted_scopes: SCOPE_KEYS.filter((k) => grants.includes(k)),
    effective_scopes: effectiveScopes(role, roleMap, grants),
  });
});

// ── PUT /scopes/users/:id — set a specific admin's additive scope grants ─────
// super_admin + users:role scope + fresh step-up + audited.
adminScopesRoutes.put("/users/:id", requireScope("users:role"), async (c: Context<AdminEnv>) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseScopes(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const { data: user, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!user) return c.json({ error: "User not found" }, 404);

  const { data: beforeRows } = await supabaseAdmin
    .from("admin_scope_grants")
    .select("scope_key")
    .eq("admin_user_id", targetId);
  const before = ((beforeRows ?? []) as Array<{ scope_key: string }>)
    .map((r) => r.scope_key)
    .filter(isScopeKey);

  // Replace the per-admin grant set.
  const { error: delErr } = await supabaseAdmin
    .from("admin_scope_grants")
    .delete()
    .eq("admin_user_id", targetId);
  if (delErr) return c.json({ error: delErr.message }, 500);

  if (parsed.scopes.length > 0) {
    const { error: insErr } = await supabaseAdmin
      .from("admin_scope_grants")
      .insert(parsed.scopes.map((scope_key) => ({
        admin_user_id: targetId,
        scope_key,
        granted_by: c.get("userId"),
      })));
    if (insErr) return c.json({ error: insErr.message }, 500);
  }

  await writeAuditLog(c, {
    action: "admin.user_scope_grants_update",
    targetType: "user",
    targetId,
    details: { before, after: parsed.scopes },
  });

  return c.json({ ok: true, granted_scopes: parsed.scopes });
});
