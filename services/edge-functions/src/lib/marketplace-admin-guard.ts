// MP-01: who may change a marketplace connection.
//
// Connecting an account, replacing the ship-from location, creating business
// policies or opting the account in or out of an eBay program all change the
// OWNER's live selling setup. Disconnect already required admin (US-1616); the
// routes that attach or reshape the connection did not, and a GET skips
// blockViewerWrites entirely, so a viewer could attach their own eBay account to
// the owner's tenant through GET /oauth/start.
//
// Role first (no I/O), then the impersonation check, which reads the database.

import { roleAtLeast, type WorkspaceRole } from "./workspace-roles.ts";
import { refuseWhileImpersonating } from "./destructive-guard.ts";

export const MARKETPLACE_ADMIN_ONLY =
  "Only a workspace admin can change marketplace connections.";

interface GuardableContext {
  get(key: "userId"): string | undefined;
  json(body: unknown, status?: number): Response;
}

/**
 * Returns a 403 when the caller is below admin in the workspace they are acting
 * in, or when the session is an impersonation. Returns null when the request may
 * proceed. A missing role means no workspace middleware ran, which is the solo
 * owner acting on their own account.
 */
export async function refuseMarketplaceChange(
  c: GuardableContext,
  role: WorkspaceRole | undefined,
  action: string,
): Promise<Response | null> {
  if (!roleAtLeast(role ?? "owner", "admin")) {
    return c.json({ error: MARKETPLACE_ADMIN_ONLY }, 403);
  }
  return await refuseWhileImpersonating(c, action);
}
