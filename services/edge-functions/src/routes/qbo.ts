import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";
import { roleAtLeast, type WorkspaceRole } from "../lib/workspace-roles.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { decryptToken } from "../lib/crypto-aes.ts";
import {
  buildQboConsentUrl,
  exchangeQboCode,
  fetchQboChartOfAccounts,
  fetchQboCompanyName,
  generateQboState,
  getQboAccessToken,
  getQboConnection,
  isPermanentQboAuthFailure,
  markQboReconnect,
  qboConfigured,
  qboEnvironment,
  QBO_RECONNECT_MESSAGE,
  revokeQboToken,
  upsertQboConnection,
  type QboEnvironment,
} from "../lib/qbo-client.ts";

// US-2997 — connect QuickBooks Online, and map the accounts.
//
// NO TRANSACTIONS MOVE HERE. That is US-2998, and the split is deliberate: a
// sale pushed into the wrong QBO account is a mess an accountant unpicks by
// hand, with no undo, so the mapping gets its own story and its own screen.
//
// TENANCY (US-268). The service-role client bypasses RLS, so every query below
// is scoped by `workspaceOwnerId ?? userId` -- a member acting inside a
// workspace targets the OWNER's tenant. The realm id comes only from the row we
// loaded that way; it is never read from a request body, because that is how a
// seller's sale would land in someone else's company file.

type QboEnv = {
  Variables: {
    userId?: string;
    workspaceOwnerId?: string;
    workspaceRole?: WorkspaceRole;
  };
};

export const qboRoutes = new Hono<QboEnv>();

function ownerOf(c: { get: (k: "workspaceOwnerId" | "userId") => unknown }) {
  return (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
}

function notConfigured() {
  return {
    error:
      "QuickBooks is not switched on for this server. Nothing you do here can reach Intuit.",
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

qboRoutes.get("/status", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const row = await getQboConnection(userId);
  // AC5: which environment is in use is always on the screen. A seller who
  // cannot see this cannot tell a sandbox sync from a real one until the
  // damage is in a real company file.
  return c.json({
    configured: qboConfigured(),
    environment: qboEnvironment(),
    connected: Boolean(row),
    connection: row
      ? {
        id: row.id,
        realm_id: row.realm_id,
        environment: row.environment,
        company_name: row.company_name,
        token_expires_at: row.token_expires_at,
        refresh_token_expires_at: row.refresh_token_expires_at,
        refresh_error: row.refresh_error,
      }
      : null,
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

qboRoutes.get("/oauth/start", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  if (!qboConfigured()) return c.json(notConfigured(), 503);

  const role = c.get("workspaceRole") ?? "owner";
  if (!roleAtLeast(role, "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }

  const state = generateQboState();
  const { error } = await supabaseAdmin.from("qbo_oauth_states").insert({
    state,
    owner_user_id: userId,
    environment: qboEnvironment(),
    redirect_to: sanitizeRelativePath(c.req.query("redirect_to")),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) return c.json({ error: "Couldn't start the connection." }, 500);

  return c.json({ consent_url: buildQboConsentUrl(state) });
});

/**
 * Intuit redirects the browser here and there is no session yet. The single-use
 * `state` row is the whole defence, and it is deleted-and-returned in one
 * statement so a replay finds nothing.
 */
qboRoutes.get("/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const realmId = c.req.query("realmId") ?? "";
  const oauthError = c.req.query("error");

  let redirectTo: string | null = null;
  const finish = (status: string) => {
    const base = redirectTo ?? "/dashboard/flipdesk/quickbooks";
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(`${base}${sep}qbo=${status}`);
  };

  if (oauthError) return finish("cancelled");
  if (!state || !code) return finish("invalid_state");

  const { data: stateRow } = await supabaseAdmin
    .from("qbo_oauth_states")
    .delete()
    .eq("state", state)
    .select("owner_user_id, redirect_to, expires_at, environment")
    .maybeSingle();

  const row = stateRow as
    | {
      owner_user_id: string;
      redirect_to: string | null;
      expires_at: string;
      environment: QboEnvironment;
    }
    | null;
  if (!row) return finish("invalid_state");
  redirectTo = row.redirect_to;
  if (Date.parse(row.expires_at) < Date.now()) return finish("state_expired");

  // AC2. The realm comes from Intuit's own redirect, alongside a state token
  // only this server minted. Without it there is no company file to talk to and
  // guessing one would be the exact mistake this AC exists to prevent.
  if (!realmId) return finish("no_realm");

  try {
    const tokens = await exchangeQboCode(code);
    const conn = await upsertQboConnection({
      userId: row.owner_user_id,
      realmId,
      environment: row.environment,
      tokens,
    });
    // Best effort, and after the row exists: a company file with no readable
    // name is still a usable connection.
    const name = await fetchQboCompanyName({
      accessToken: tokens.accessToken,
      realmId,
      environment: row.environment,
      connectionId: conn.id,
    });
    if (name) {
      await supabaseAdmin
        .from("qbo_connections")
        .update({ company_name: name })
        .eq("id", conn.id)
        .eq("user_id", row.owner_user_id);
    }
    return finish("connected");
  } catch {
    return finish("exchange_failed");
  }
});

qboRoutes.post("/disconnect", async (c) => {
  const blocked = await refuseWhileImpersonating(c, "Disconnecting QuickBooks");
  if (blocked) return blocked;

  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }

  const { data: rows } = await supabaseAdmin
    .from("qbo_connections")
    .select("id, refresh_token_encrypted")
    .eq("user_id", userId)
    .eq("is_active", true);

  let revoked = 0;
  for (const r of (rows ?? []) as { id: string; refresh_token_encrypted: string | null }[]) {
    if (!r.refresh_token_encrypted) continue;
    try {
      const token = await decryptToken(r.refresh_token_encrypted, { aad: userId });
      if (await revokeQboToken(token)) revoked++;
    } catch {
      // An upstream revoke that fails must not stop the local teardown. The
      // token is deleted below either way; leaving it because Intuit was down
      // is the worse outcome.
    }
  }

  // Always local-teardown, whatever the upstream said. Idempotent 200.
  await supabaseAdmin
    .from("qbo_connections")
    .update({
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      refresh_token_expires_at: null,
      refresh_error: "disconnected",
    })
    .eq("user_id", userId);

  return c.json({ ok: true, revoked });
});

// ---------------------------------------------------------------------------
// The chart of accounts, and the mapping. AC3 / AC4.
// ---------------------------------------------------------------------------

qboRoutes.get("/accounts", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  if (!qboConfigured()) return c.json(notConfigured(), 503);

  try {
    const auth = await getQboAccessToken(userId);
    const accounts = await fetchQboChartOfAccounts(auth);
    return c.json({ accounts, realm_id: auth.realmId, environment: auth.environment });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't reach QuickBooks.";
    // AC6. A reconnect is a 409 rather than a 500, because the caller has
    // something to DO about it and a 500 reads as "try again later".
    if (msg === QBO_RECONNECT_MESSAGE) return c.json({ error: msg, reconnect: true }, 409);
    return c.json({ error: msg }, 502);
  }
});

qboRoutes.get("/mappings", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { data } = await supabaseAdmin
    .from("qbo_account_mappings")
    .select("account_code, qbo_account_id, qbo_account_name, basis, updated_at")
    .eq("user_id", userId);
  return c.json({ mappings: data ?? [] });
});

/**
 * Save the mapping. The connection is loaded owner-scoped FIRST and every row
 * is keyed on its id, so a connection_id in the body could not target another
 * tenant even if one were sent -- and none is read.
 */
qboRoutes.put("/mappings", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const conn = await getQboConnection(userId);
  if (!conn) return c.json({ error: "QuickBooks is not connected." }, 400);

  const body = (await c.req.json().catch(() => null)) as
    | { mappings?: { account_code?: string; qbo_account_id?: string | null; qbo_account_name?: string | null; basis?: string }[] }
    | null;
  const incoming = body?.mappings;
  if (!Array.isArray(incoming)) {
    return c.json({ error: "Send a mappings array." }, 400);
  }
  if (incoming.length > 200) {
    return c.json({ error: "That is more accounts than exist." }, 400);
  }

  const allowedBasis = new Set(["subtype", "type", "name", "manual"]);
  const toUpsert: Record<string, unknown>[] = [];
  const toClear: string[] = [];

  for (const m of incoming) {
    const code = typeof m?.account_code === "string" ? m.account_code.trim() : "";
    if (!code) continue;
    // An empty id is not an error, it is the seller UNMAPPING an account. That
    // has to be expressible or a wrong mapping can never be taken back.
    if (!m.qbo_account_id) {
      toClear.push(code);
      continue;
    }
    toUpsert.push({
      user_id: userId,
      connection_id: conn.id,
      account_code: code,
      qbo_account_id: String(m.qbo_account_id),
      qbo_account_name: m.qbo_account_name ?? null,
      basis: allowedBasis.has(String(m.basis)) ? m.basis : "manual",
    });
  }

  if (toClear.length > 0) {
    await supabaseAdmin
      .from("qbo_account_mappings")
      .delete()
      .eq("user_id", userId)
      .eq("connection_id", conn.id)
      .in("account_code", toClear);
  }
  if (toUpsert.length > 0) {
    const { error } = await supabaseAdmin
      .from("qbo_account_mappings")
      .upsert(toUpsert, { onConflict: "connection_id,account_code" });
    if (error) return c.json({ error: "Couldn't save the mapping." }, 500);
  }

  return c.json({ ok: true, saved: toUpsert.length, cleared: toClear.length });
});

// ---------------------------------------------------------------------------
// The refresh sweep. Registered in CRON_REGISTRY as qbo-token-refresh.
// ---------------------------------------------------------------------------

/**
 * AC1 and AC6. Runs hourly and rotates anything lapsing within a day.
 *
 * It does the work through getQboAccessToken, which is the same path a live
 * request takes -- so the sweep cannot drift from the real refresh. Its second
 * job is louder than its first: a refresh token that has aged past 100 days
 * gets is_active cleared and the reconnect wording written where the status
 * card reads it, instead of failing quietly once an hour for ever.
 */
qboRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);
  if (!qboConfigured()) return c.json({ ok: true, skipped: "not configured" });

  const cutoff = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const { data } = await supabaseAdmin
    .from("qbo_connections")
    .select("id, user_id, refresh_token_expires_at")
    .eq("is_active", true)
    .lt("token_expires_at", cutoff)
    .order("token_expires_at", { ascending: true })
    .limit(200);

  const rows = (data ?? []) as {
    id: string;
    user_id: string;
    refresh_token_expires_at: string | null;
  }[];

  let refreshed = 0;
  let reconnectNeeded = 0;
  let failed = 0;

  for (const row of rows) {
    // The 100-day clock. Catching it HERE means the seller is told while they
    // can still act, rather than at the moment they next open the screen.
    if (
      row.refresh_token_expires_at &&
      Date.parse(row.refresh_token_expires_at) < Date.now()
    ) {
      await markQboReconnect(row.id, row.user_id, QBO_RECONNECT_MESSAGE);
      reconnectNeeded++;
      continue;
    }
    try {
      await getQboAccessToken(row.user_id);
      refreshed++;
    } catch (err) {
      if (isPermanentQboAuthFailure(err)) {
        await markQboReconnect(row.id, row.user_id, QBO_RECONNECT_MESSAGE);
        reconnectNeeded++;
      } else {
        failed++;
      }
    }
  }

  return c.json({
    ok: true,
    summary: { scanned: rows.length, refreshed, reconnect_needed: reconnectNeeded, failed },
  });
});
