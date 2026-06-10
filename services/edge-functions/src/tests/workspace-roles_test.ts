// US-351 / US-799: workspace role hierarchy + member-management gate. Pure
// logic, runs offline.
import { assert, assertEquals } from "@std/assert";
import {
  ASSIGNABLE_ROLES,
  canAssignRole,
  canManageMember,
  roleAtLeast,
} from "../lib/workspace-roles.ts";

Deno.test("owner is never an assignable role", () => {
  assertEquals(ASSIGNABLE_ROLES.includes("owner" as never), false);
});

Deno.test("an admin cannot assign owner (the core escalation case)", () => {
  assertEquals(canAssignRole("admin", "owner"), false);
});

Deno.test("an admin can assign up to admin", () => {
  assert(canAssignRole("admin", "admin"));
  assert(canAssignRole("admin", "listing_manager"));
  assert(canAssignRole("admin", "member"));
  assert(canAssignRole("admin", "viewer"));
});

Deno.test("nobody can assign owner — not even the owner (owner is implicit)", () => {
  assertEquals(canAssignRole("owner", "owner"), false);
});

Deno.test("an owner can assign any assignable role", () => {
  for (const r of ASSIGNABLE_ROLES) {
    assert(canAssignRole("owner", r), `owner should assign ${r}`);
  }
});

Deno.test("a lower role cannot assign above its own level", () => {
  assertEquals(canAssignRole("listing_manager", "admin"), false);
  assert(canAssignRole("listing_manager", "listing_manager"));
  assertEquals(canAssignRole("member", "listing_manager"), false);
  assertEquals(canAssignRole("viewer", "member"), false);
});

Deno.test("roleAtLeast ordering sanity", () => {
  assert(roleAtLeast("owner", "admin"));
  assert(roleAtLeast("admin", "admin"));
  assertEquals(roleAtLeast("member", "admin"), false);
});

// ── US-799: canManageMember (remove / role-change gate) ──────────────

Deno.test("a non-admin member cannot manage anyone", () => {
  for (const target of ASSIGNABLE_ROLES) {
    assertEquals(canManageMember("member", target), false);
    assertEquals(canManageMember("viewer", target), false);
    assertEquals(canManageMember("listing_manager", target), false);
  }
});

Deno.test("the owner (as a member-row role) can never be managed via the member endpoints", () => {
  assertEquals(canManageMember("admin", "owner"), false);
  assertEquals(canManageMember("owner", "owner"), false);
});

Deno.test("an admin can manage members at or below admin", () => {
  assert(canManageMember("admin", "admin"));
  assert(canManageMember("admin", "listing_manager"));
  assert(canManageMember("admin", "member"));
  assert(canManageMember("admin", "viewer"));
});

Deno.test("an owner can manage any non-owner member", () => {
  assert(canManageMember("owner", "admin"));
  assert(canManageMember("owner", "viewer"));
});
