import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";
import { roleAtLeast, type WorkspaceRole } from "../lib/workspace-roles.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { decryptToken } from "../lib/crypto-aes.ts";
import {
  qboErrorText,
  type AccountMap,
  type PendingDocument,
} from "../lib/qbo-documents.ts";
import {
  pushDocuments,
  type QboRef,
  type QboTransport,
  type SyncLogRow,
  type SyncLogStore,
} from "../lib/qbo-sync.ts";
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
  qboFetch,
  QBO_RECONNECT_MESSAGE,
  revokeQboToken,
  upsertQboConnection,
  type QboAuth,
  type QboEnvironment,
} from "../lib/qbo-client.ts";

// US-2997 and US-2998 — connect QuickBooks Online, map the accounts, push.
//
// The mapping came first and shipped on its own, because a sale pushed into the
// wrong QBO account is a mess an accountant unpicks by hand with no undo. The
// push below only ever runs against a mapping the seller has already seen and
// saved, and an account they never mapped blocks its own documents and nothing
// else.
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

// ---------------------------------------------------------------------------
// The push. US-2998.
//
// ONE WAY ONLY, GradeThread to QuickBooks. Nothing below reads a QuickBooks
// edit back, and the UI says so. Two-way is a much larger problem and
// pretending to do it is how books get corrupted.
// ---------------------------------------------------------------------------

/** A bounded batch. AC7: three years of history must not be one request. */
const SYNC_BATCH = 40;

const ENTITY_QUERY_NAME: Record<string, string> = {
  salesreceipt: "SalesReceipt",
  purchase: "Purchase",
  deposit: "Deposit",
};

function refFrom(entity: string, text: string): QboRef {
  const json = JSON.parse(text) as Record<string, { Id?: string; SyncToken?: string }>;
  const body = json[ENTITY_QUERY_NAME[entity] ?? entity];
  if (!body?.Id) throw new Error("QuickBooks accepted the document but returned no id.");
  return { id: body.Id, syncToken: body.SyncToken ?? "0" };
}

/** The live QuickBooks transport, built per request from the tenant's tokens. */
function transportFor(auth: QboAuth): QboTransport {
  return {
    async find(entity, docNumber) {
      // The entity name inside a query is PascalCase; the REST path is lower.
      // The doc number is ours and matches /^GT-[SED][0-9a-f]{16}$/, but it is
      // stripped of quotes anyway: a value interpolated into a query string is
      // a value interpolated into a query string.
      const table = ENTITY_QUERY_NAME[entity] ?? entity;
      const safe = docNumber.replace(/[^A-Za-z0-9-]/g, "");
      const q = `select * from ${table} where DocNumber = '${safe}'`;
      const res = await qboFetch(auth, `/query?query=${encodeURIComponent(q)}`, {
        method: "GET",
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const json = (await res.json()) as {
        QueryResponse?: Record<string, { Id: string; SyncToken: string }[]>;
      };
      const rows = json.QueryResponse?.[table] ?? [];
      const hit = rows[0];
      return hit ? { id: hit.Id, syncToken: hit.SyncToken } : null;
    },

    async create(entity, payload) {
      const res = await qboFetch(auth, `/${entity}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(qboErrorText(res.status, text));
      return refFrom(entity, text);
    },

    async update(entity, payload, ref) {
      // QuickBooks needs the Id and the CURRENT SyncToken on every update and
      // rejects a stale one rather than overwriting. That is the behaviour we
      // want: a token we no longer hold means somebody edited the document
      // inside QuickBooks, and this sync is one way.
      const res = await qboFetch(auth, `/${entity}?operation=update`, {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          Id: ref.id,
          SyncToken: ref.syncToken,
          sparse: true,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(qboErrorText(res.status, text));
      return refFrom(entity, text);
    },
  };
}

function isYmd(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function mergeCounts(
  prev: Record<string, number>,
  r: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    blocked: number;
    attached: number;
  },
): Record<string, number> {
  return {
    created: (prev.created ?? 0) + r.created,
    updated: (prev.updated ?? 0) + r.updated,
    skipped: (prev.skipped ?? 0) + r.skipped,
    failed: (prev.failed ?? 0) + r.failed,
    blocked: (prev.blocked ?? 0) + r.blocked,
    attached: (prev.attached ?? 0) + r.attached,
  };
}

/**
 * The log, tenant-scoped at every call. The service-role client bypasses RLS,
 * so the user id is on the WRITE as well as on the read that found the row.
 */
function syncLogStore(userId: string, connectionId: string): SyncLogStore {
  return {
    async get(kind, sourceId) {
      const { data } = await supabaseAdmin
        .from("qbo_sync_log")
        .select(
          "object_kind, source_id, doc_number, qbo_id, qbo_sync_token, payload_hash, status",
        )
        .eq("user_id", userId)
        .eq("object_kind", kind)
        .eq("source_id", sourceId)
        .maybeSingle();
      return (data ?? null) as SyncLogRow | null;
    },
    async put(row) {
      await supabaseAdmin.from("qbo_sync_log").upsert(
        {
          user_id: userId,
          connection_id: connectionId,
          object_kind: row.object_kind,
          source_id: row.source_id,
          doc_number: row.doc_number,
          qbo_id: row.qbo_id,
          qbo_sync_token: row.qbo_sync_token,
          payload_hash: row.payload_hash,
          status: row.status,
          error_text: row.error_text,
          pushed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,object_kind,source_id" },
      );
    },
  };
}

qboRoutes.post("/sync", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  if (!qboConfigured()) return c.json(notConfigured(), 503);

  const body = (await c.req.json().catch(() => null)) as
    | { period_start?: string; period_end?: string; run_id?: string }
    | null;
  const from = isYmd(body?.period_start) ? body!.period_start! : null;
  const to = isYmd(body?.period_end) ? body!.period_end! : null;
  if (!from || !to || from >= to) {
    return c.json({ error: "Send a period_start and a period_end, end exclusive." }, 400);
  }

  const conn = await getQboConnection(userId);
  if (!conn) return c.json({ error: "QuickBooks is not connected." }, 400);

  let auth: QboAuth;
  try {
    auth = await getQboAccessToken(userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't reach QuickBooks.";
    if (msg === QBO_RECONNECT_MESSAGE) return c.json({ error: msg, reconnect: true }, 409);
    return c.json({ error: msg }, 502);
  }

  // The mapping, owner-scoped. An account with no row is unmapped, which blocks
  // its own documents and nothing else.
  const { data: mapRows } = await supabaseAdmin
    .from("qbo_account_mappings")
    .select("account_code, qbo_account_id")
    .eq("user_id", userId)
    .eq("connection_id", conn.id);
  const map: AccountMap = {};
  for (const m of (mapRows ?? []) as { account_code: string; qbo_account_id: string }[]) {
    map[m.account_code] = m.qbo_account_id;
  }

  // Resume, or start. A run id from the body is verified against the tenant
  // before it is used: an id in a request is attacker-controlled input.
  type RunRow = { id: string; cursor_date: string | null; counts: Record<string, number> };
  let run: RunRow | null = null;
  if (body?.run_id) {
    const { data } = await supabaseAdmin
      .from("qbo_sync_runs")
      .select("id, cursor_date, counts")
      .eq("id", body.run_id)
      .eq("user_id", userId)
      .maybeSingle();
    run = (data ?? null) as RunRow | null;
    if (!run) return c.json({ error: "No such sync run." }, 404);
  }
  if (!run) {
    const { data, error } = await supabaseAdmin
      .from("qbo_sync_runs")
      .insert({
        user_id: userId,
        connection_id: conn.id,
        period_start: from,
        period_end: to,
        status: "running",
      })
      .select("id, cursor_date, counts")
      .single();
    if (error) return c.json({ error: "Couldn't start the sync." }, 500);
    run = data as unknown as RunRow;
  }

  const { data: pending, error: pendingError } = await supabaseAdmin.rpc(
    "qbo_pending_documents",
    {
      p_user_id: userId,
      p_from: from,
      p_to: to,
      p_after: run.cursor_date,
      p_limit: SYNC_BATCH,
    },
  );
  if (pendingError) return c.json({ error: "Couldn't read your books." }, 500);
  const docs = (pending ?? []) as PendingDocument[];

  const result = await pushDocuments(docs, {
    transport: transportFor(auth),
    map,
    bankAccountId: map.cash_payout,
    log: syncLogStore(userId, conn.id),
    payoutSales: async (sourceId) => {
      const { data } = await supabaseAdmin.rpc("qbo_payout_sales", {
        p_user_id: userId,
        p_payout_id: sourceId,
      });
      return (data ?? []) as { sale_id: string; sale_date: string; title: string }[];
    },
    hasReceipt: async (sourceId) => {
      const { data } = await supabaseAdmin
        .from("flipdesk_expenses")
        .select("receipt_path")
        .eq("id", sourceId)
        .eq("user_id", userId)
        .maybeSingle();
      return Boolean((data as { receipt_path: string | null } | null)?.receipt_path);
    },
  });

  // The bookmark. A batch shorter than the cap means there was nothing behind
  // it, so the run is done; otherwise the next call resumes AT the last date
  // seen rather than after it, because several documents can share a date and
  // the log turns the repeats into skips.
  const lastDate = docs.length > 0 ? docs[docs.length - 1]!.doc_date : null;
  const done = docs.length < SYNC_BATCH;
  const counts = mergeCounts(run.counts ?? {}, result);

  await supabaseAdmin
    .from("qbo_sync_runs")
    .update({
      cursor_date: done ? null : lastDate,
      status: done ? "done" : "paused",
      counts,
      last_error: result.entries.find((e) => e.status === "failed")?.error ?? null,
      ...(done ? { finished_at: new Date().toISOString() } : {}),
    })
    .eq("id", run.id)
    .eq("user_id", userId);

  return c.json({
    run_id: run.id,
    done,
    batch: result,
    counts,
    // AC8, in the response as well as on the screen.
    direction: "GradeThread to QuickBooks only",
  });
});

qboRoutes.get("/sync/log", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { data } = await supabaseAdmin
    .from("qbo_sync_log")
    .select("object_kind, source_id, doc_number, qbo_id, status, error_text, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  return c.json({ entries: data ?? [] });
});

qboRoutes.get("/sync/runs", async (c) => {
  const userId = ownerOf(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { data } = await supabaseAdmin
    .from("qbo_sync_runs")
    .select(
      "id, period_start, period_end, cursor_date, status, counts, last_error, started_at, finished_at",
    )
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(10);
  return c.json({ runs: data ?? [] });
});
