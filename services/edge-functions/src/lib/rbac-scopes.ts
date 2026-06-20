// Granular RBAC permission scopes — PURE model (US-908).
//
// Scopes sit ON TOP OF the four fixed platform roles. They are purely additive:
// every sensitive endpoint keeps its existing role + MFA gate and ADDS a
// requireScope() check. The seed in migration 00298 maps the existing roles to
// exactly their current effective permissions, so authorization decisions are
// unchanged at launch (proved by the parity test rbac-scopes_test.ts).
//
// This file is dependency-free (no supabase/env) so the catalog + the decision
// logic are unit-testable with no env dance. The DB-backed loader + the request
// guard live in scope-guard.ts.

export type UserRole = "user" | "reviewer" | "admin" | "super_admin";

// The assignable permission scopes. Mirrors permission_scopes seeded in 00298.
export const SCOPE_KEYS = [
  "billing:write",
  "grading:review",
  "moderation:write",
  "content:publish",
  "users:role",
] as const;

export type ScopeKey = (typeof SCOPE_KEYS)[number];

export interface PermissionScope {
  key: ScopeKey;
  label: string;
  description: string;
  category: string;
}

// Catalog metadata (kept in sync with the 00298 seed; the DB is the source of
// truth at runtime, this is the fallback + the type-safe key list).
export const PERMISSION_SCOPES: PermissionScope[] = [
  {
    key: "billing:write",
    label: "Billing operations",
    description: "Change plans, grant/adjust credits, issue refunds, and manage coupons.",
    category: "billing",
  },
  {
    key: "grading:review",
    label: "Grading review",
    description: "Review and override AI grade outcomes in the human-review queue.",
    category: "grading",
  },
  {
    key: "moderation:write",
    label: "Content moderation",
    description: "Approve or reject flagged submissions and take down listings/photos.",
    category: "moderation",
  },
  {
    key: "content:publish",
    label: "Content publishing",
    description: "Create and publish blog posts, changelog entries, and newsletter issues.",
    category: "content",
  },
  {
    key: "users:role",
    label: "Role & permission management",
    description: "Grant or revoke admin roles and edit which scopes a role or admin holds.",
    category: "users",
  },
];

export function isScopeKey(v: unknown): v is ScopeKey {
  return typeof v === "string" && (SCOPE_KEYS as readonly string[]).includes(v);
}

// Default role → scopes mapping. THIS IS THE PARITY SOURCE OF TRUTH and equals
// the 00298 role_scopes seed:
//   super_admin → implicit-all (handled in roleHasScope, never enumerated)
//   admin       → everything except users:role (role grants were always
//                 super_admin-only)
//   reviewer    → grading:review only (is_reviewer_or_admin)
//   user        → no admin scopes
// The runtime loader (scope-guard.ts) reads role_scopes from the DB and falls
// back to this map if the table is unreadable, so a DB blip can't silently widen
// or revoke access.
export const DEFAULT_ROLE_SCOPES: Record<UserRole, ScopeKey[]> = {
  super_admin: [...SCOPE_KEYS],
  admin: ["billing:write", "grading:review", "moderation:write", "content:publish"],
  reviewer: ["grading:review"],
  user: [],
};

// Pure scope decision. super_admin implicitly holds every scope. For any other
// role, membership is checked against `roleScopes` (defaults to
// DEFAULT_ROLE_SCOPES) plus any extra per-admin grants passed in `extraGrants`.
export function roleHasScope(
  role: UserRole | null | undefined,
  scope: ScopeKey,
  roleScopes: Partial<Record<UserRole, ScopeKey[]>> = DEFAULT_ROLE_SCOPES,
  extraGrants: readonly ScopeKey[] = [],
): boolean {
  if (role === "super_admin") return true;
  if (!role) return false;
  if (extraGrants.includes(scope)) return true;
  const scopes = roleScopes[role] ?? [];
  return scopes.includes(scope);
}

// The effective scope set a role holds (super_admin = all). Used by the admin UI
// and the per-admin effective-scope endpoint.
export function effectiveScopes(
  role: UserRole | null | undefined,
  roleScopes: Partial<Record<UserRole, ScopeKey[]>> = DEFAULT_ROLE_SCOPES,
  extraGrants: readonly ScopeKey[] = [],
): ScopeKey[] {
  if (role === "super_admin") return [...SCOPE_KEYS];
  if (!role) return [];
  const base = roleScopes[role] ?? [];
  const set = new Set<ScopeKey>([...base, ...extraGrants]);
  return SCOPE_KEYS.filter((k) => set.has(k));
}
