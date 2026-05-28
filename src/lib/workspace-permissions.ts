import type { WorkspaceRole } from "@/types/database";

// Capabilities checked by the UI. The matrix below mirrors the policy
// thresholds in migration 00042 — keep them in sync.
export type WorkspaceCapability =
  | "view"
  | "submit_grade"
  | "manage_inventory"
  | "delete_inventory"
  | "manage_marketplaces"
  | "manage_api_keys"
  | "manage_members"
  | "manage_billing"
  | "delete_workspace";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  member: 2,
  listing_manager: 3,
  admin: 4,
  owner: 5,
};

// Minimum role required for each capability.
const CAPABILITY_MIN_ROLE: Record<WorkspaceCapability, WorkspaceRole> = {
  view: "viewer",
  submit_grade: "member",
  manage_inventory: "listing_manager",
  delete_inventory: "admin",
  manage_marketplaces: "admin",
  manage_api_keys: "admin",
  manage_members: "admin",
  manage_billing: "owner",
  delete_workspace: "owner",
};

export function roleRank(role: WorkspaceRole): number {
  return ROLE_RANK[role];
}

export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function canDo(role: WorkspaceRole | null | undefined, cap: WorkspaceCapability): boolean {
  if (!role) return false;
  return roleAtLeast(role, CAPABILITY_MIN_ROLE[cap]);
}

export const WORKSPACE_ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Shop Admin",
  admin: "Admin",
  listing_manager: "Listing Manager",
  member: "Member",
  viewer: "Viewer",
};

export const WORKSPACE_ROLE_DESCRIPTION: Record<WorkspaceRole, string> = {
  owner:
    "Full access. Manages billing, members, marketplaces, and can delete the workspace.",
  admin:
    "Full access except billing and workspace deletion. Can manage members and marketplaces.",
  listing_manager:
    "Create and edit inventory, listings, sources, and grade submissions. Cannot manage members or billing.",
  member:
    "Submit grade requests and view all data. Cannot edit inventory or listings.",
  viewer: "Read-only access to everything in the workspace.",
};

// Roles an owner/admin can ASSIGN when inviting a new member. 'owner' is
// reserved — it's only ever the workspace owner themselves.
export const ASSIGNABLE_WORKSPACE_ROLES: WorkspaceRole[] = [
  "admin",
  "listing_manager",
  "member",
  "viewer",
];
