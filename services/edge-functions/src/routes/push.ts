// US-1901: browser push subscription management.
//
// The frontend registers a PushManager subscription and POSTs it here; the edge
// stores it (per-tenant) and later fans notifications out to it via notify.ts →
// deliverPush(). Mounted behind authMiddleware + workspaceMiddleware in main.ts,
// so every row is written/read under the resolved workspace owner.
//
// SECURITY (US-268): the service-role client bypasses RLS, so every query is
// explicitly scoped by `.eq("user_id", ownerId)`. The one deliberate exception
// is /subscribe's conflict handling: a push endpoint is globally unique and
// possession of the endpoint + its keys proves the browser, so an upsert that
// re-homes an endpoint to the current owner is safe (and expected when a shared
// device switches accounts). /unsubscribe is strictly owner-scoped.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { getVapidConfig } from "../lib/web-push.ts";

type PushEnv = {
  Variables: { userId: string; workspaceOwnerId?: string };
};

export const pushRoutes = new Hono<PushEnv>();

function ownerOf(c: { get: (k: "workspaceOwnerId" | "userId") => string | undefined }): string {
  return c.get("workspaceOwnerId") ?? c.get("userId")!;
}

// GET /api/push/vapid-public-key — the browser needs the application-server
// public key to create a subscription. Exposed so the client doesn't require a
// build-time env (though VITE_VAPID_PUBLIC_KEY is also honored client-side).
pushRoutes.get("/vapid-public-key", (c) => {
  const vapid = getVapidConfig();
  if (!vapid) {
    // Push isn't provisioned on this deploy — tell the client cleanly so it can
    // hide the control instead of erroring.
    return c.json({ key: null, enabled: false });
  }
  return c.json({ key: vapid.publicKey, enabled: true });
});

// POST /api/push/subscribe { endpoint, keys:{p256dh, auth}, userAgent? }
pushRoutes.post("/subscribe", async (c) => {
  const ownerId = ownerOf(c);
  const body = await c.req.json().catch(() => null) as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string }; userAgent?: string }
    | null;

  const endpoint = body?.endpoint?.trim();
  const p256dh = body?.keys?.p256dh?.trim();
  const auth = body?.keys?.auth?.trim();
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "endpoint + keys.p256dh + keys.auth are required" }, 400);
  }

  // Upsert on the globally-unique endpoint. onConflict overwrites user_id to the
  // current owner: whoever presents the endpoint + keys is, by definition, the
  // browser that holds them, so re-homing a stale endpoint to this account is
  // correct (and prevents a dead row for another user blocking the insert).
  const { error } = await supabaseAdmin
    .from("push_subscriptions")
    .upsert(
      {
        user_id: ownerId,
        endpoint,
        p256dh,
        auth,
        user_agent: body?.userAgent ?? c.req.header("User-Agent") ?? null,
        last_used_at: new Date().toISOString(),
        failure_count: 0,
      },
      { onConflict: "endpoint" },
    );

  if (error) {
    console.error(`[push] subscribe upsert failed for ${ownerId}: ${error.message}`);
    return c.json({ error: "Could not save subscription" }, 500);
  }
  return c.json({ ok: true });
});

// POST /api/push/unsubscribe { endpoint } — idempotent, strictly owner-scoped.
pushRoutes.post("/unsubscribe", async (c) => {
  const ownerId = ownerOf(c);
  const body = await c.req.json().catch(() => null) as { endpoint?: string } | null;
  const endpoint = body?.endpoint?.trim();
  if (!endpoint) {
    return c.json({ error: "endpoint is required" }, 400);
  }

  const { error } = await supabaseAdmin
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", ownerId);

  if (error) {
    console.error(`[push] unsubscribe failed for ${ownerId}: ${error.message}`);
    return c.json({ error: "Could not remove subscription" }, 500);
  }
  return c.json({ ok: true });
});
