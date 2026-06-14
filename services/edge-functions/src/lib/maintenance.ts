// US-887: maintenance mode + scheduled maintenance windows — read helpers,
// validation, and the PURE enforcement decision the edge guard uses.
//
// maintenance_windows (migration 00211) is the source of truth: a scope
// (platform | grading | flipdesk | checkout) put into a mode
// (banner | read_only | blocked), optionally on a schedule (starts_at/ends_at).
// This module is the single read path:
//   • active windows are served from a short-TTL in-process cache (one DB hit
//     per window, not per request — the grading hot path goes through the guard);
//   • the cache is busted immediately on an admin write (bustMaintenanceCache) so
//     an enable/disable lands on the next request instead of after the TTL;
//   • reads fail OPEN (never block traffic on a DB error) — on failure we serve
//     the last cached set, else an empty set (no enforcement).
//
// The decision function (decideMaintenance) is pure + exported so the guard and
// its tests share one source of truth — including the guarantee that admins are
// NEVER blocked (AC#6) and that /api/admin is always exempt.

import { supabaseAdmin } from "./supabase.ts";

export type MaintenanceScope = "platform" | "grading" | "flipdesk" | "checkout";
export type MaintenanceMode = "banner" | "read_only" | "blocked";

export const MAINTENANCE_SCOPES: readonly MaintenanceScope[] = [
  "platform",
  "grading",
  "flipdesk",
  "checkout",
];
export const MAINTENANCE_MODES: readonly MaintenanceMode[] = [
  "banner",
  "read_only",
  "blocked",
];

export function isMaintenanceScope(v: unknown): v is MaintenanceScope {
  return typeof v === "string" &&
    (MAINTENANCE_SCOPES as readonly string[]).includes(v);
}
export function isMaintenanceMode(v: unknown): v is MaintenanceMode {
  return typeof v === "string" &&
    (MAINTENANCE_MODES as readonly string[]).includes(v);
}

export interface MaintenanceWindow {
  id: string;
  scope: MaintenanceScope;
  mode: MaintenanceMode;
  message: string;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MAINTENANCE_SELECT =
  "id, scope, mode, message, starts_at, ends_at, is_active, created_by, created_at, updated_at";

// A window is "effective now" when its master switch is on AND the current time
// is inside its schedule window. A future starts_at = scheduled-but-not-yet-live;
// a past ends_at = expired. NULL bounds are open (effective immediately / until
// ended).
export function isWindowEffective(w: MaintenanceWindow, nowMs: number): boolean {
  if (!w.is_active) return false;
  if (w.starts_at && Date.parse(w.starts_at) > nowMs) return false;
  if (w.ends_at && Date.parse(w.ends_at) <= nowMs) return false;
  return true;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Map a request path to the maintenance scopes that govern it. A user-facing
// action path is governed by its subsystem scope AND the platform-wide scope.
// Anything that doesn't map to a subsystem returns an empty set (never enforced).
export function scopesForPath(path: string): Set<MaintenanceScope> {
  const scopes = new Set<MaintenanceScope>();
  if (path.startsWith("/api/grade")) scopes.add("grading");
  else if (path.startsWith("/api/flipdesk")) scopes.add("flipdesk");
  else if (path.startsWith("/api/payments")) scopes.add("checkout");
  // A platform window covers every user-facing subsystem path.
  if (scopes.size > 0) scopes.add("platform");
  return scopes;
}

// Paths that are NEVER subject to maintenance enforcement — even under a
// platform-wide block. Admin management (so admins can end a window — AC#6),
// scheduled crons, inbound provider webhooks, and OAuth callbacks must keep
// flowing so the platform can be operated and integrations don't lose events.
export function isMaintenanceExemptPath(path: string): boolean {
  if (path.startsWith("/api/admin")) return true;
  if (path.startsWith("/api/jobs")) return true;
  if (path.startsWith("/api/maintenance")) return true;
  if (path.includes("/webhooks")) return true;
  if (path.includes("/oauth/callback")) return true;
  if (path.includes("/oauth/refresh")) return true;
  return false;
}

export interface MaintenanceDecision {
  action: "allow" | "block";
  status?: 503;
  code?: "MAINTENANCE" | "MAINTENANCE_READ_ONLY";
  message?: string;
  scope?: MaintenanceScope;
}

// PURE decision. Given the request shape, the caller's admin status, and the
// currently-effective windows, decide whether to allow or block. Severity order
// is blocked > read_only > banner.
//
// Guarantees (covered by maintenance_test.ts):
//   • an admin is ALWAYS allowed (never locked out — AC#6);
//   • an exempt path (notably /api/admin) is ALWAYS allowed;
//   • 'blocked' stops every in-scope request for non-admins;
//   • 'read_only' stops only writes for non-admins (GET passes);
//   • 'banner' never blocks.
export function decideMaintenance(params: {
  path: string;
  method: string;
  isAdmin: boolean;
  windows: MaintenanceWindow[];
}): MaintenanceDecision {
  const { path, method, isAdmin, windows } = params;

  if (isAdmin) return { action: "allow" };
  if (isMaintenanceExemptPath(path)) return { action: "allow" };

  const scopes = scopesForPath(path);
  if (scopes.size === 0) return { action: "allow" };

  const applicable = windows.filter((w) => scopes.has(w.scope));
  if (applicable.length === 0) return { action: "allow" };

  const blocked = applicable.find((w) => w.mode === "blocked");
  if (blocked) {
    return {
      action: "block",
      status: 503,
      code: "MAINTENANCE",
      message: blocked.message,
      scope: blocked.scope,
    };
  }

  if (WRITE_METHODS.has(method.toUpperCase())) {
    const readOnly = applicable.find((w) => w.mode === "read_only");
    if (readOnly) {
      return {
        action: "block",
        status: 503,
        code: "MAINTENANCE_READ_ONLY",
        message: readOnly.message,
        scope: readOnly.scope,
      };
    }
  }

  return { action: "allow" };
}

// ── Active-window cache ───────────────────────────────────────────

const TTL_MS = 30_000;
interface CacheEntry {
  windows: MaintenanceWindow[];
  expiresAt: number;
}
let cache: CacheEntry | null = null;

async function loadActiveWindows(): Promise<MaintenanceWindow[]> {
  const { data, error } = await supabaseAdmin
    .from("maintenance_windows")
    .select(MAINTENANCE_SELECT)
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []) as MaintenanceWindow[];
}

// All windows whose master switch is on (effective or scheduled), read-through
// cached. Fails open: on a DB error serve the last cached set, else [].
export async function getActiveWindows(): Promise<MaintenanceWindow[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.windows;
  try {
    const windows = await loadActiveWindows();
    cache = { windows, expiresAt: now + TTL_MS };
    return windows;
  } catch (err) {
    console.error(
      "[maintenance] active-window read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return cache ? cache.windows : [];
  }
}

// Windows that are effective RIGHT NOW (the ones the guard enforces + the SPA
// banner shows). Scheduled-future windows are filtered out.
export async function getEffectiveWindows(
  nowMs: number = Date.now(),
): Promise<MaintenanceWindow[]> {
  const active = await getActiveWindows();
  return active.filter((w) => isWindowEffective(w, nowMs));
}

export function bustMaintenanceCache(): void {
  cache = null;
}

// ── Admin-role cache (for the guard's bypass check) ───────────────
//
// The guard runs on user-facing routes where adminAuthMiddleware did NOT run, so
// it resolves the caller's admin status here. Cached per user (short TTL) so a
// blocked window doesn't add a DB hit to every request on the hot path.

const ROLE_TTL_MS = 60_000;
const roleCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

export async function isAdminUserCached(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = roleCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.isAdmin;
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    const role = (data as { role?: string } | null)?.role ?? null;
    const isAdmin = role === "admin" || role === "super_admin";
    roleCache.set(userId, { isAdmin, expiresAt: now + ROLE_TTL_MS });
    return isAdmin;
  } catch {
    // On error treat as non-admin (safe: at worst an admin is briefly subject to
    // a window). The window read itself fails open, so this is only reached when
    // a window IS active.
    return hit ? hit.isAdmin : false;
  }
}
