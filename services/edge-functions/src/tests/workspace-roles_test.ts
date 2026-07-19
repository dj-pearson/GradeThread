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

// ── US-2039 AC4: workspace owner resolution ─────────────────────────
//
// X-Workspace-Owner decides WHICH TENANT a member writes into. It is the most
// security-critical routing decision in the product and had no test importing
// it — the logic sat inline in a Hono middleware that loads the service-role
// supabase client, so it was untestable in practice. Now extracted and pinned.

const { resolveRequestedOwner, resolveWorkspaceAccess } = await import(
  "../lib/workspace-roles.ts"
);

const ALICE = "user-alice";
const BOB = "user-bob";

Deno.test("no header resolves to the caller's own workspace", () => {
  for (const header of [undefined, null, "", "   "]) {
    const r = resolveRequestedOwner(ALICE, header);
    assertEquals(r, { self: true, ownerId: ALICE }, `header=${JSON.stringify(header)}`);
  }
});

// The trimming matters: a padded header naming the caller must resolve as SELF,
// not fall through to a membership lookup that would (correctly) find no row
// and 403 the user out of their own workspace.
Deno.test("a padded header naming the caller is still self, not a lookup", () => {
  assertEquals(resolveRequestedOwner(ALICE, `  ${ALICE}  `), { self: true, ownerId: ALICE });
});

Deno.test("a header naming someone else targets THAT workspace, not the caller's", () => {
  const r = resolveRequestedOwner(ALICE, BOB);
  assertEquals(r, { self: false, ownerId: BOB });
  // The critical property: resolution never silently falls back to the caller.
  // Doing so would send a cross-tenant write into the caller's own tenant.
  assertEquals(r?.ownerId === ALICE, false);
});

Deno.test("no auth context resolves to null so the caller 401s", () => {
  for (const uid of [undefined, null, "", "   "]) {
    assertEquals(resolveRequestedOwner(uid, BOB), null, `userId=${JSON.stringify(uid)}`);
  }
});

// ── access decisions for another tenant's workspace ─────────────────

const BASE = {
  ownerId: BOB,
  lookupFailed: false,
  ownerMfaRequiredRole: null,
  sessionAal2: false,
};

Deno.test("a real membership is allowed, acting as the OWNER's tenant", () => {
  const d = resolveWorkspaceAccess({ ...BASE, member: { role: "listing_manager" } });
  assertEquals(d, { action: "allow", ownerId: BOB, role: "listing_manager" });
});

Deno.test("no membership row is denied with the recoverable revoked code", () => {
  const d = resolveWorkspaceAccess({ ...BASE, member: null });
  assertEquals(d.action, "deny");
  if (d.action === "deny") {
    assertEquals(d.status, 403);
    assertEquals(d.errorCode, "workspace_access_revoked");
  }
});

// THE BRANCH THAT MATTERS MOST: a DB blip must not read as "access granted".
// "We could not determine membership" and "membership confirmed" must never
// resolve the same way.
Deno.test("a failed lookup FAILS CLOSED with 500, never allow", () => {
  const d = resolveWorkspaceAccess({ ...BASE, member: { role: "admin" }, lookupFailed: true });
  assertEquals(d.action, "deny");
  if (d.action === "deny") assertEquals(d.status, 500);
});

// A blank/absent role on a present row is malformed data, not a valid grant.
// Treating it as a role would hand out access with an empty role string.
Deno.test("a membership row with a blank role is denied, not granted", () => {
  for (const role of [null, "", "   "]) {
    const d = resolveWorkspaceAccess({ ...BASE, member: { role } });
    assertEquals(d.action, "deny", `role=${JSON.stringify(role)}`);
  }
});

Deno.test("the owner's MFA policy blocks an aal1 member at or above the threshold", () => {
  const d = resolveWorkspaceAccess({
    ...BASE,
    member: { role: "admin" },
    ownerMfaRequiredRole: "admin",
    sessionAal2: false,
  });
  assertEquals(d.action, "deny");
  if (d.action === "deny") {
    assertEquals(d.status, 403);
    assertEquals(d.errorCode, "workspace_mfa_required");
  }
});

Deno.test("the same member at aal2 is allowed through the MFA policy", () => {
  const d = resolveWorkspaceAccess({
    ...BASE,
    member: { role: "admin" },
    ownerMfaRequiredRole: "admin",
    sessionAal2: true,
  });
  assertEquals(d, { action: "allow", ownerId: BOB, role: "admin" });
});

// C3-adjacent: a viewer resolves as a viewer, which is what blockViewerWrites
// then keys on. If resolution ever returned a higher role here, the viewer
// write-floor would silently stop applying.
Deno.test("a viewer resolves as exactly 'viewer' so the write floor still applies", () => {
  const d = resolveWorkspaceAccess({ ...BASE, member: { role: "viewer" } });
  assertEquals(d, { action: "allow", ownerId: BOB, role: "viewer" });
});
