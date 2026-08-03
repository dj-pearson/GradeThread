// US-2351 AC3: destructive user-facing actions refuse while an impersonation is
// in flight.
//
// The scenario the story names, and it is not far-fetched: a super_admin
// impersonates a customer who is disputing a charge, cancels their subscription
// and deletes their account. Every downstream record — the Stripe event, the
// deletion log, the marketplace disconnect — shows the CUSTOMER doing it. The
// admin's audit trail says only "impersonation started".
//
// "View as" exists to SEE what a user sees. Nothing about that requires the
// power to end their account, and an admin who genuinely needs to act on a
// user's behalf has admin endpoints that record them as the actor.
//
// WHY A HELPER AND NOT A MIDDLEWARE. A blanket middleware over `/api/*` would
// have to enumerate what is destructive anyway, and every route it did not know
// about would be silently permitted — the same failure shape as the whole-file
// scope check US-2354 replaced. An explicit call at each site is a decision
// someone made, and a guard test enumerates the sites.

import { isImpersonated } from "./impersonation-session.ts";

/**
 * The slice of a Hono context this needs, rather than a concrete `Context<Env>`.
 *
 * Every router here declares its own Env — some carry workspaceOwnerId and a
 * workspace role, some only userId — and a guard typed against one of them will
 * not accept the others. Structural typing keeps the guard usable at every site
 * instead of tempting the next person to reach for `as never`.
 */
interface GuardableContext {
  get(key: "userId"): string | undefined;
  json(body: unknown, status?: number): Response;
}

/**
 * Returns a 403 Response when the caller's session is an impersonation, or null
 * when the request may proceed.
 *
 * Reads FAIL CLOSED (see isImpersonated): a database blip refuses the action
 * rather than permitting it. Being wrong that way costs a real user one retry;
 * being wrong the other way is unrecoverable.
 */
export async function refuseWhileImpersonating(
  c: GuardableContext,
  action: string,
): Promise<Response | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  if (!(await isImpersonated(userId, Date.now()))) return null;
  return c.json(
    {
      error:
        `${action} is not available while an admin is viewing this account. ` +
        `Exit impersonation first.`,
      code: "impersonation_blocked",
    },
    403,
  );
}
