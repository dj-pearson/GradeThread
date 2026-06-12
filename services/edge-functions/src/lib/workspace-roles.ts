// Workspace role hierarchy — pure logic, no DB import, so it is unit-testable
// (the role-assignment cap, US-351). middleware/workspace.ts re-exports these.
// Mirrors src/lib/workspace-permissions.ts on the frontend. Keep in sync.

export type WorkspaceRole =
  | "viewer"
  | "member"
  | "listing_manager"
  | "admin"
  | "owner";

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  member: 2,
  listing_manager: 3,
  admin: 4,
  owner: 5,
};

export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// Roles that may be granted via an invitation or a member role-change. 'owner'
// is implicit (never a workspace_members row), so it is the ceiling and is
// excluded here.
export const ASSIGNABLE_ROLES: WorkspaceRole[] = [
  "admin",
  "listing_manager",
  "member",
  "viewer",
];

/**
 * US-351: whether an actor with `actorRole` may assign `targetRole`. The target
 * must be an assignable (non-owner) role AND no higher than the actor's own
 * role. So an admin may assign up to admin (never owner), a listing_manager up
 * to listing_manager, etc.
 */
export function canAssignRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  if (!ASSIGNABLE_ROLES.includes(targetRole)) return false;
  return roleAtLeast(actorRole, targetRole);
}

/**
 * US-799: whether an actor may MANAGE (remove / change the role of) a member who
 * currently holds `targetCurrentRole`. The actor must be admin+ and must
 * outrank-or-equal the target. The owner is never a workspace_members row, so a
 * target whose current role resolves to 'owner' is never manageable through the
 * member endpoints (guards against demoting/removing the owner). This is the
 * "can I touch this member at all" gate; role CHANGES additionally pass the new
 * role through canAssignRole().
 */
export function canManageMember(
  actorRole: WorkspaceRole,
  targetCurrentRole: WorkspaceRole,
): boolean {
  if (!roleAtLeast(actorRole, "admin")) return false;
  if (targetCurrentRole === "owner") return false;
  return roleAtLeast(actorRole, targetCurrentRole);
}

// Roles an owner may pick as the MFA-enforcement threshold. 'owner' is excluded
// — the policy targets MEMBERS, and the owner is never forced by their own
// policy (they have other, admin-area MFA paths). null = enforcement off.
export const MFA_THRESHOLD_ROLES: WorkspaceRole[] = [
  "viewer",
  "member",
  "listing_manager",
  "admin",
];

/**
 * US-374: whether a workspace MEMBER must be BLOCKED for not satisfying the
 * workspace's MFA policy. Pure (no DB / no JWT decode) so the gate is
 * unit-testable. Blocks iff the owner set a threshold, the member's role meets
 * or exceeds it, and the member's session is NOT AAL2 (MFA unsatisfied).
 *
 * The caller passes `requiredRole` (the owner's `workspace_mfa_required_role`,
 * or null when unset) and `isSessionAal2` (decoded from the verified token).
 * Owners acting in their own workspace should never be passed here.
 */
export function workspaceMfaBlocked(
  memberRole: WorkspaceRole,
  requiredRole: WorkspaceRole | null | undefined,
  isSessionAal2: boolean,
): boolean {
  if (!requiredRole) return false; // no policy → never blocked
  if (!roleAtLeast(memberRole, requiredRole)) return false; // below threshold
  return !isSessionAal2;
}
