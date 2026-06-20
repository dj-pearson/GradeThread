// US-908 parity + invariant tests for the granular RBAC scope model.
//
// PURE (imports only rbac-scopes.ts — no env/DB dance). The headline guarantee
// is AC5: the seeded scope mapping yields IDENTICAL authorization decisions to
// today's role checks for every endpoint we put behind requireScope. If a future
// edit to DEFAULT_ROLE_SCOPES would change who can reach billing / role-grant /
// moderation, this test fails.

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_ROLE_SCOPES,
  effectiveScopes,
  isScopeKey,
  PERMISSION_SCOPES,
  roleHasScope,
  type ScopeKey,
  SCOPE_KEYS,
  type UserRole,
} from "../lib/rbac-scopes.ts";

const ALL_ROLES: UserRole[] = ["user", "reviewer", "admin", "super_admin"];

// adminAuthMiddleware gates /api/admin/* to admin + super_admin BEFORE any scope
// check, so non-admins are denied regardless of scope.
function passesAdminGate(role: UserRole): boolean {
  return role === "admin" || role === "super_admin";
}

// Each protected endpoint = its LEGACY role gate + the scope we added.
//   legacyGate "admin"       → admin or super_admin (the inherited admin gate)
//   legacyGate "super_admin" → super_admin only (an explicit in-handler check)
interface ProtectedEndpoint {
  name: string;
  legacyGate: "admin" | "super_admin";
  scope: ScopeKey;
}

const PROTECTED_ENDPOINTS: ProtectedEndpoint[] = [
  { name: "admin-billing/* (change-plan, credits, refunds, coupons)", legacyGate: "admin", scope: "billing:write" },
  { name: "admin-users POST /:id/role", legacyGate: "super_admin", scope: "users:role" },
  { name: "admin-moderation/* (approve, reject, takedown)", legacyGate: "admin", scope: "moderation:write" },
];

function legacyAllowed(ep: ProtectedEndpoint, role: UserRole): boolean {
  return ep.legacyGate === "super_admin" ? role === "super_admin" : passesAdminGate(role);
}

// The NEW decision: pass the admin gate AND hold the scope (super_admin implicit).
function scopeAllowed(ep: ProtectedEndpoint, role: UserRole): boolean {
  return passesAdminGate(role) && roleHasScope(role, ep.scope, DEFAULT_ROLE_SCOPES);
}

Deno.test("AC5 parity: scope decision matches legacy role decision for every endpoint × role", () => {
  for (const ep of PROTECTED_ENDPOINTS) {
    for (const role of ALL_ROLES) {
      assertEquals(
        scopeAllowed(ep, role),
        legacyAllowed(ep, role),
        `parity mismatch: ${ep.name} for role "${role}" — ` +
          `legacy=${legacyAllowed(ep, role)} scope=${scopeAllowed(ep, role)}`,
      );
    }
  }
});

Deno.test("super_admin implicitly holds every scope", () => {
  for (const scope of SCOPE_KEYS) {
    assert(roleHasScope("super_admin", scope), `super_admin missing ${scope}`);
  }
  assertEquals(effectiveScopes("super_admin").sort(), [...SCOPE_KEYS].sort());
});

Deno.test("admin holds everything except users:role (role grants stay super_admin-only)", () => {
  assert(roleHasScope("admin", "billing:write"));
  assert(roleHasScope("admin", "moderation:write"));
  assert(roleHasScope("admin", "grading:review"));
  assert(roleHasScope("admin", "content:publish"));
  assertEquals(roleHasScope("admin", "users:role"), false);
});

Deno.test("reviewer holds only grading:review; user holds nothing", () => {
  assertEquals(effectiveScopes("reviewer"), ["grading:review"]);
  assertEquals(effectiveScopes("user"), []);
});

Deno.test("a per-admin grant adds a scope without changing the role", () => {
  // An `admin` granted users:role can now pass that gate (the support-agent case).
  assertEquals(roleHasScope("admin", "users:role"), false);
  assert(roleHasScope("admin", "users:role", DEFAULT_ROLE_SCOPES, ["users:role"]));
  assert(effectiveScopes("admin", DEFAULT_ROLE_SCOPES, ["users:role"]).includes("users:role"));
});

Deno.test("catalog and default map stay in sync with SCOPE_KEYS", () => {
  assertEquals(PERMISSION_SCOPES.map((s) => s.key).sort(), [...SCOPE_KEYS].sort());
  // Every scope referenced in the default map is a real scope key.
  for (const role of ALL_ROLES) {
    for (const s of DEFAULT_ROLE_SCOPES[role]) {
      assert(isScopeKey(s), `${role} references unknown scope ${s}`);
    }
  }
});
