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

// ── US-2039 AC4: workspace owner resolution (pure) ───────────────────
//
// The X-Workspace-Owner header decides WHICH TENANT a member writes into. It is
// the single most security-critical piece of routing in the product — get it
// wrong and one tenant's writes land in another's data — and it had NO test
// importing it, because the logic lived inline in a Hono middleware that pulls
// in the service-role supabase client at module load.
//
// So the decision is extracted here, matching the idiom the rest of this
// codebase already uses (planAutoPayout, planReversal, evaluateAlerts): a pure
// function that takes the lookup RESULTS and returns what to do, with the
// middleware reduced to fetching and applying. The middleware keeps the I/O;
// this keeps the reasoning, and the reasoning is what needs pinning.

/** Where a request should act, or why it must be refused. */
export type WorkspaceAccessDecision =
  | { action: "allow"; ownerId: string; role: WorkspaceRole }
  | { action: "deny"; status: 401 | 403 | 500; error: string; errorCode?: string };

/**
 * Resolve the target workspace from the header, WITHOUT any lookup.
 *
 * Returns `self: true` when the request acts in the caller's own workspace —
 * absent header, blank header, or a header naming the caller. The middleware
 * uses this to skip the membership query entirely, so the trimming rules here
 * decide whether a request touches the DB at all.
 */
export function resolveRequestedOwner(
  userId: string | null | undefined,
  header: string | null | undefined,
): { self: boolean; ownerId: string } | null {
  const caller = (userId ?? "").trim();
  if (!caller) return null; // no auth context — the caller must 401.
  const requested = (header ?? "").trim();
  if (requested.length === 0) return { self: true, ownerId: caller };
  return { self: requested === caller, ownerId: requested };
}

/**
 * Decide access for a request targeting ANOTHER user's workspace, given the
 * membership row and the owner's MFA policy.
 *
 * `member: null` means no membership row exists — which is also what a REVOKED
 * membership looks like, hence the machine-readable code so a client holding a
 * stale X-Workspace-Owner can clear it and recover rather than seeing an
 * unexplained 403.
 */
export function resolveWorkspaceAccess(input: {
  ownerId: string;
  member: { role: string | null } | null;
  lookupFailed: boolean;
  ownerMfaRequiredRole: WorkspaceRole | null;
  sessionAal2: boolean;
}): WorkspaceAccessDecision {
  // Fail CLOSED on a lookup error. "We could not determine membership" must
  // never resolve the same way as "membership confirmed" — this is the branch
  // where a DB blip would otherwise hand out cross-tenant access.
  if (input.lookupFailed) {
    return { action: "deny", status: 500, error: "Workspace lookup failed" };
  }

  const role = (input.member?.role ?? "").trim() as WorkspaceRole;
  if (!input.member || !role) {
    return {
      action: "deny",
      status: 403,
      error: "You don't have access to this workspace",
      errorCode: "workspace_access_revoked",
    };
  }

  if (workspaceMfaBlocked(role, input.ownerMfaRequiredRole, input.sessionAal2)) {
    return {
      action: "deny",
      status: 403,
      error:
        "This workspace requires two-factor authentication for your role. " +
        "Enable 2FA in Settings, then sign in again to continue.",
      errorCode: "workspace_mfa_required",
    };
  }

  return { action: "allow", ownerId: input.ownerId, role };
}
