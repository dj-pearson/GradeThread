// US-351: workspace role-assignment cap. Pure hierarchy logic, runs offline.
import { assert, assertEquals } from "@std/assert";
import {
  ASSIGNABLE_ROLES,
  canAssignRole,
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
