// Request-time scope enforcement (US-908).
//
// requireScope("billing:write") is a Hono middleware applied alongside the
// existing role + MFA gates (never instead of them). It reads the caller's
// adminRole (set by adminAuthMiddleware) and asserts the role — or a per-admin
// additive grant — holds the scope. super_admin implicitly holds every scope.
//
// The role→scopes mapping is loaded from the DB (role_scopes) and cached for a
// short TTL so the admin scope editor takes effect fleet-wide without a deploy.
// A read failure falls back to the static DEFAULT_ROLE_SCOPES (rbac-scopes.ts)
// so a DB blip can never silently widen OR revoke access.

import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "./supabase.ts";
import {
  DEFAULT_ROLE_SCOPES,
  isScopeKey,
  roleHasScope,
  type ScopeKey,
  type UserRole,
} from "./rbac-scopes.ts";

const CACHE_TTL_MS = 60_000;

interface RoleScopeCache {
  map: Partial<Record<UserRole, ScopeKey[]>>;
  loadedAt: number;
}

let cache: RoleScopeCache | null = null;
let inFlight: Promise<Partial<Record<UserRole, ScopeKey[]>>> | null = null;

// Invalidate the cached role→scopes map (call after an admin edits role_scopes).
export function clearScopeCache(): void {
  cache = null;
}

async function fetchRoleScopes(): Promise<Partial<Record<UserRole, ScopeKey[]>>> {
  const { data, error } = await supabaseAdmin
    .from("role_scopes")
    .select("role, scope_key");
  if (error || !data) {
    console.warn(
      `[scope-guard] role_scopes read failed, falling back to defaults: ${error?.message ?? "no data"}`,
    );
    return DEFAULT_ROLE_SCOPES;
  }
  const rows = data as Array<{ role: string; scope_key: string }>;
  const map: Partial<Record<UserRole, ScopeKey[]>> = {};
  for (const r of rows) {
    if (!isScopeKey(r.scope_key)) continue;
    const role = r.role as UserRole;
    (map[role] ??= []).push(r.scope_key);
  }
  // super_admin is implicit-all in code — never depend on DB rows for it.
  return map;
}

// Cached role→scopes map. Concurrent callers share one in-flight load.
export async function getRoleScopes(): Promise<Partial<Record<UserRole, ScopeKey[]>>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.map;
  if (inFlight) return inFlight;
  inFlight = fetchRoleScopes()
    .then((map) => {
      cache = { map, loadedAt: Date.now() };
      return map;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Per-admin additive grants (scopes beyond the role). Only consulted when the
// role itself doesn't already hold the requested scope, so the common path is a
// single cached lookup with no extra query.
async function userGrantedScopes(userId: string): Promise<ScopeKey[]> {
  const { data, error } = await supabaseAdmin
    .from("admin_scope_grants")
    .select("scope_key")
    .eq("admin_user_id", userId);
  if (error || !data) return [];
  return (data as Array<{ scope_key: string }>)
    .map((r) => r.scope_key)
    .filter(isScopeKey);
}

// Does this caller hold the scope? super_admin = always; otherwise role mapping
// then a per-admin grant. Exported for the per-admin effective-scope endpoint.
export async function callerHasScope(
  role: UserRole | null | undefined,
  userId: string | null,
  scope: ScopeKey,
): Promise<boolean> {
  if (role === "super_admin") return true;
  const map = await getRoleScopes();
  if (roleHasScope(role, scope, map)) return true;
  if (!userId) return false;
  const grants = await userGrantedScopes(userId);
  return grants.includes(scope);
}

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

// Hono middleware: gate a route/router on a permission scope. Apply AFTER
// authMiddleware + adminAuthMiddleware (which set userId + adminRole). Returns a
// 403 with code SCOPE_REQUIRED when the caller lacks the scope.
//
//   adminBillingRoutes.use("*", requireScope("billing:write"));
//   adminUsersRoutes.post("/:id/role", requireScope("users:role"), handler);
export function requireScope(scope: ScopeKey) {
  return createMiddleware<AdminEnv>(async (c, next) => {
    const role = c.get("adminRole") as UserRole | undefined;
    if (!role) {
      return c.json({ error: "Admin context required" }, 403);
    }
    const allowed = await callerHasScope(role, c.get("userId") ?? null, scope);
    if (!allowed) {
      return c.json({
        error: `You don't have the required permission for this action (${scope}).`,
        code: "SCOPE_REQUIRED",
        scope,
      }, 403);
    }
    await next();
  });
}
