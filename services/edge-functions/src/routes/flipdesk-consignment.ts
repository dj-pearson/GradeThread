// US-600: Consignment mode — consignor portal, configurable splits, per-consignor
// P&L, intake e-sign, and Stripe Connect payouts.
//
// Mounted at /api/flipdesk/consignment (auth + workspace middleware in main.ts).
// Service-role client BYPASSES RLS — every query is explicitly tenant-scoped to
// `workspaceOwnerId ?? userId` (see CLAUDE.md US-268), and any write that takes
// an id from the request body first confirms the caller owns that row.

import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import { redactError } from "../lib/log-redact.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";

type ConsignmentEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskConsignmentRoutes = new Hono<ConsignmentEnv>();

function tenantId(c: { get: (k: "workspaceOwnerId" | "userId") => string }): string {
  return c.get("workspaceOwnerId") ?? c.get("userId");
}

// Test seam: driven-router tests swap in a stub Stripe client.
let stripeOverride: Stripe | null | undefined;
export function setConsignmentStripeForTests(stripe: unknown): void {
  stripeOverride = stripe === undefined ? undefined : (stripe as Stripe | null);
}

function getStripe(): Stripe | null {
  if (stripeOverride !== undefined) return stripeOverride;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    console.error("STRIPE_SECRET_KEY not configured");
    return null;
  }
  return new Stripe(key, {
    apiVersion: "2024-04-10",
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
}

function siteUrl(): string {
  return Deno.env.get("SITE_URL") || "https://gradethread.com";
}

// C1: money terms (split, status, signature, Stripe destination, payouts)
// are admin-only. blockViewerWrites keeps viewers out of every write, but a
// member or listing_manager could otherwise raise a split to 100%, record a
// "signature" or start Stripe onboarding with their own bank details.
export const CONSIGNOR_MONEY_ADMIN_ONLY = "Only a workspace admin can change payouts or splits.";

function requireAdmin(c: {
  get: (k: "workspaceRole") => ConsignmentEnv["Variables"]["workspaceRole"] | undefined;
  json: (body: unknown, status: 403) => Response;
}): Response | null {
  if (roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) return null;
  return c.json({ error: CONSIGNOR_MONEY_ADMIN_ONLY }, 403);
}

// C8: a split must be a finite number in 0-100. A bad value is an error, not
// a quiet 50 or a clamp to 100.
function parseSplit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

const FIELD_CAPS = {
  name: 120,
  contact_email: 254,
  contact_phone: 32,
  notes: 2000,
} as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns the first field that breaks its cap or format, or null.
function contactFieldError(fields: {
  name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  notes?: string | null;
}): string | null {
  for (const key of Object.keys(FIELD_CAPS) as Array<keyof typeof FIELD_CAPS>) {
    const v = fields[key];
    if (typeof v === "string" && v.length > FIELD_CAPS[key]) {
      return `${key} must be ${FIELD_CAPS[key]} characters or fewer`;
    }
  }
  if (typeof fields.contact_email === "string" && !EMAIL_RE.test(fields.contact_email)) {
    return "contact_email is not a valid email address";
  }
  return null;
}

function trimmedOrNull(v: unknown): string | null {
  return typeof v === "string" ? v.trim() || null : null;
}

// Postgres unique_violation on (user_id, name).
function duplicateName(c: { json: (body: unknown, status: 409) => Response }, name: string) {
  return c.json(
    { error: `You already have a consignor named "${name}". Pick a different name.` },
    409,
  );
}

// C5: parse a dollar amount into integer cents exactly once. Accepts a number
// or a string with at most two decimals. Returns null for anything else.
export const MAX_PAYOUT_CENTS = 100_000_000; // $1,000,000.00
export function parseAmountCents(value: unknown): number | null {
  const s = typeof value === "number"
    ? (Number.isFinite(value) ? String(value) : "")
    : typeof value === "string"
    ? value.trim()
    : "";
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_PAYOUT_CENTS) return null;
  return cents;
}

function toCents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// C5: plain copy for a failed transfer. The raw Stripe text stays on the row.
export function stripeTransferErrorCopy(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const c = typeof code === "string" ? code : "";
  if (c === "balance_insufficient") return "Your Stripe balance can't cover this payout yet.";
  if (c === "account_invalid" || c.includes("capabilit")) {
    return "They need to finish Stripe setup first.";
  }
  return "The transfer didn't go through.";
}

// Confirm the caller owns this consignor; returns the row or null.
async function loadConsignorOwned(userId: string, consignorId: string) {
  const { data } = await supabaseAdmin
    .from("consignors")
    .select("*")
    .eq("id", consignorId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

// ── Consignors ──────────────────────────────────────────────────

// GET /consignors — directory + per-consignor P&L.
// C10: both reads run together, and a failed P&L read is reported as
// pnl_error rather than a list of $0.00 balances.
flipdeskConsignmentRoutes.get("/consignors", async (c) => {
  const userId = tenantId(c);

  const [list, pnlRes] = await Promise.all([
    supabaseAdmin
      .from("consignors")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("consignor_pnl")
      .select("*")
      .eq("user_id", userId),
  ]);
  if (list.error) {
    return failSafe(c, 500, "Couldn't load consignors.", list.error, "consignment.list");
  }
  const pnlError = Boolean(pnlRes.error);
  if (pnlRes.error) {
    console.error(`[consignment.list.pnl] ${redactError(pnlRes.error)}`);
  }

  const pnlById = new Map<string, Record<string, unknown>>();
  for (const row of pnlRes.data ?? []) {
    pnlById.set((row as { consignor_id: string }).consignor_id, row as Record<string, unknown>);
  }

  const merged = (list.data ?? []).map((row) => ({
    ...row,
    pnl: pnlById.get((row as { id: string }).id) ?? null,
  }));

  return c.json({ consignors: merged, pnl_error: pnlError });
});

// POST /consignors — create a consignor.
flipdeskConsignmentRoutes.post("/consignors", async (c) => {
  const userId = tenantId(c);
  const body = await c.req.json().catch(() => ({}));

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const rawSplit = body.default_split_pct ?? body.split_pct;
  let split = 50;
  if (rawSplit !== undefined) {
    const parsed = parseSplit(rawSplit);
    if (parsed === null) return c.json({ error: "default_split_pct must be 0-100" }, 400);
    split = parsed;
  }
  // A non-default split is a money term (C1).
  if (split !== 50) {
    const denied = requireAdmin(c);
    if (denied) return denied;
  }

  const fields = {
    name,
    contact_email: trimmedOrNull(body.contact_email),
    contact_phone: trimmedOrNull(body.contact_phone),
    notes: trimmedOrNull(body.notes),
  };
  const bad = contactFieldError(fields);
  if (bad) return c.json({ error: bad }, 400);

  const { data, error } = await supabaseAdmin
    .from("consignors")
    .insert({ user_id: userId, ...fields, default_split_pct: split })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return duplicateName(c, name);
    return failSafe(c, 500, "Couldn't create the consignor.", error, "consignment.create");
  }

  return c.json({ consignor: data }, 201);
});

// PATCH /consignors/:id — update name / contact / split / status / notes.
// C1: split and status are admin-only; name, contact and notes are not.
// C8: changing the split voids the signed agreement.
flipdeskConsignmentRoutes.patch("/consignors/:id", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const touchesMoney = "default_split_pct" in body || "split_pct" in body || "status" in body;
  if (touchesMoney) {
    const denied = requireAdmin(c);
    if (denied) return denied;
  }

  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const patch: Record<string, unknown> = {};
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    patch.name = name;
  }
  if ("contact_email" in body) patch.contact_email = trimmedOrNull(body.contact_email);
  if ("contact_phone" in body) patch.contact_phone = trimmedOrNull(body.contact_phone);
  if ("notes" in body) patch.notes = trimmedOrNull(body.notes);
  const bad = contactFieldError(patch as Parameters<typeof contactFieldError>[0]);
  if (bad) return c.json({ error: bad }, 400);

  let resignRequired = false;
  if ("default_split_pct" in body || "split_pct" in body) {
    const split = parseSplit(body.default_split_pct ?? body.split_pct);
    if (split === null) return c.json({ error: "default_split_pct must be 0-100" }, 400);
    patch.default_split_pct = split;
    if (split !== Number(existing.default_split_pct) && existing.intake_signed_at) {
      patch.intake_signed_at = null;
      patch.intake_signature_name = null;
      patch.intake_agreement_version = null;
      resignRequired = true;
    }
  }
  if ("status" in body) {
    if (typeof body.status !== "string" || !["active", "paused", "archived"].includes(body.status)) {
      return c.json({ error: "status must be active, paused or archived" }, 400);
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No valid fields" }, 400);

  const { data, error } = await supabaseAdmin
    .from("consignors")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return duplicateName(c, String(patch.name ?? existing.name));
    }
    return failSafe(c, 500, "Couldn't update the consignor.", error, "consignment.update");
  }

  return c.json({ consignor: data, resign_required: resignRequired });
});

// POST /consignors/:id/intake — record the consignment-agreement e-signature.
flipdeskConsignmentRoutes.post("/consignors/:id/intake", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const signatureName = typeof body.signature_name === "string" ? body.signature_name.trim() : "";
  if (!signatureName) return c.json({ error: "signature_name is required" }, 400);
  if (signatureName.length > FIELD_CAPS.name) {
    return c.json({ error: `signature_name must be ${FIELD_CAPS.name} characters or fewer` }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("consignors")
    .update({
      intake_signed_at: new Date().toISOString(),
      intake_signature_name: signatureName,
      intake_agreement_version:
        typeof body.agreement_version === "string" && body.agreement_version.trim()
          ? body.agreement_version.trim().slice(0, 32)
          : "v1",
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) return failSafe(c, 500, "Couldn't save the intake agreement.", error, "consignment.intake");

  return c.json({ consignor: data });
});

// POST /consignors/:id/connect — create (or reuse) a Stripe Connect Express
// account and return an onboarding link the consignor completes.
// The ownership 404 comes BEFORE the Payments-not-configured 503, so a foreign
// id is refused the same way whether or not Stripe is set up (C2).
flipdeskConsignmentRoutes.post("/consignors/:id/connect", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  const setupFailed = "Couldn't start Stripe setup. Try again in a minute.";
  let accountId = existing.stripe_connect_account_id as string | null;
  try {
    if (!accountId) {
      // C4: the key makes a double click or a second tab reuse one account.
      const account = await stripe.accounts.create(
        {
          type: "express",
          email: (existing.contact_email as string | null) ?? undefined,
          capabilities: { transfers: { requested: true } },
          metadata: { consignor_id: id, user_id: userId },
        },
        { idempotencyKey: `consignor_connect_${id}` },
      );
      accountId = account.id;
      // Only fill an empty slot; a concurrent request may have won.
      const { data: written, error: writeErr } = await supabaseAdmin
        .from("consignors")
        .update({ stripe_connect_account_id: accountId })
        .eq("id", id)
        .eq("user_id", userId)
        .is("stripe_connect_account_id", null)
        .select("stripe_connect_account_id");
      if (writeErr) {
        return failSafe(c, 500, setupFailed, writeErr, "consignment.connect.write");
      }
      if (!written || written.length === 0) {
        const again = await loadConsignorOwned(userId, id);
        const stored = again?.stripe_connect_account_id as string | null | undefined;
        if (stored) accountId = stored;
      }
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${siteUrl()}/dashboard/flipdesk/consignment?connect=refresh&consignor=${id}`,
      return_url: `${siteUrl()}/dashboard/flipdesk/consignment?connect=done&consignor=${id}`,
      type: "account_onboarding",
    });
    return c.json({ url: link.url });
  } catch (err) {
    return failSafe(c, 502, setupFailed, err, "consignment.connect.stripe");
  }
});

// GET /consignors/:id/connect/status — refresh payouts_enabled from Stripe.
// C3: the account only requests the transfers capability, so charges_enabled
// may never turn true. Readiness is transfers active plus payouts enabled.
flipdeskConsignmentRoutes.get("/consignors/:id/connect/status", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const accountId = existing.stripe_connect_account_id as string | null;
  if (!accountId) return c.json({ connected: false, payouts_enabled: false, requirements_due: [] });

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (err) {
    return failSafe(c, 502, "Couldn't check Stripe right now. Try again in a minute.", err, "consignment.connect.status");
  }
  const enabled = account.capabilities?.transfers === "active" &&
    Boolean(account.payouts_enabled);
  if (enabled !== Boolean(existing.payouts_enabled)) {
    const { error } = await supabaseAdmin
      .from("consignors")
      .update({ payouts_enabled: enabled })
      .eq("id", id)
      .eq("user_id", userId);
    if (error) {
      return failSafe(c, 500, "Couldn't save the Stripe status.", error, "consignment.connect.status.write");
    }
  }

  return c.json({
    connected: true,
    payouts_enabled: enabled,
    details_submitted: Boolean(account.details_submitted),
    requirements_due: account.requirements?.currently_due ?? [],
  });
});

// ── Consigned items (C15) ───────────────────────────────────────

// GET /consignors/:id/items — the items attached to one consignor.
flipdeskConsignmentRoutes.get("/consignors/:id/items", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const { data, error } = await supabaseAdmin
    .from("inventory_items")
    .select("id, title, brand, sku, status, target_price, consignment_split_pct")
    .eq("user_id", userId)
    .eq("consignor_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return failSafe(c, 500, "Couldn't load this consignor's items.", error, "consignment.items.list");
  return c.json({ items: data ?? [] });
});

// GET /unassigned-items?q= — the caller's own unsold items with no consignor,
// for the "Add items" picker. Tenant-scoped; takes no id from the caller.
const NOT_ASSIGNABLE = ["sold", "shipped", "completed", "archived", "keeping", "wearing"];
flipdeskConsignmentRoutes.get("/unassigned-items", async (c) => {
  const userId = tenantId(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);

  let query = supabaseAdmin
    .from("inventory_items")
    .select("id, title, brand, sku, status, target_price")
    .eq("user_id", userId)
    .is("consignor_id", null)
    .not("status", "in", `(${NOT_ASSIGNABLE.join(",")})`)
    .order("created_at", { ascending: false })
    .limit(50);
  // Strip PostgREST filter syntax out of the search text before ilike.
  const term = q.replace(/[%_,()*\\]/g, " ").trim();
  if (term) query = query.ilike("title", `%${term}%`);

  const { data, error } = await query;
  if (error) return failSafe(c, 500, "Couldn't load your items.", error, "consignment.items.unassigned");
  return c.json({ items: data ?? [] });
});

// POST /consignors/:id/items — attach (or with unassign: true, detach) items.
// The consignor is owner-verified, and every item write is scoped to the
// caller's tenant, so a foreign item id simply matches nothing.
flipdeskConsignmentRoutes.post("/consignors/:id/items", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const userId = tenantId(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const ids = Array.isArray(body.item_ids)
    ? [...new Set((body.item_ids as unknown[]).filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))]
    : [];
  if (ids.length === 0) return c.json({ error: "item_ids must be a non-empty list of item ids" }, 400);
  if (ids.length > 100) return c.json({ error: "Attach at most 100 items at a time" }, 400);

  const consignor = await loadConsignorOwned(userId, id);
  if (!consignor) return c.json({ error: "Consignor not found" }, 404);

  const unassign = body.unassign === true;
  const query = unassign
    ? supabaseAdmin
      .from("inventory_items")
      .update({ consignor_id: null, consignment_split_pct: null })
      .in("id", ids)
      .eq("user_id", userId)
      .eq("consignor_id", id)
    : supabaseAdmin
      .from("inventory_items")
      .update({
        consignor_id: id,
        consignment_split_pct: consignor.default_split_pct,
      })
      .in("id", ids)
      .eq("user_id", userId)
      .is("consignor_id", null);
  const { data, error } = await query.select("id");
  if (error) return failSafe(c, 500, "Couldn't update those items.", error, "consignment.items.assign");
  return c.json({ updated: (data ?? []).length });
});

// ── Payouts ─────────────────────────────────────────────────────

// GET /payouts — payout ledger (optionally ?consignor_id=, ?before=<created_at>).
// C11: capped at 200 rows per page.
export const PAYOUT_PAGE_SIZE = 200;
flipdeskConsignmentRoutes.get("/payouts", async (c) => {
  const userId = tenantId(c);
  const consignorId = c.req.query("consignor_id");
  const before = c.req.query("before");
  if (consignorId && !UUID_RE.test(consignorId)) {
    return c.json({ error: "consignor_id must be a valid id" }, 400);
  }
  if (before && !Number.isFinite(Date.parse(before))) {
    return c.json({ error: "before must be a timestamp" }, 400);
  }

  let query = supabaseAdmin
    .from("consignor_payouts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(PAYOUT_PAGE_SIZE);
  if (consignorId) query = query.eq("consignor_id", consignorId);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) return failSafe(c, 500, "Couldn't load payouts.", error, "consignment.payouts.list");
  const payouts = data ?? [];
  return c.json({ payouts, has_more: payouts.length === PAYOUT_PAGE_SIZE });
});

// POST /payouts — pay a consignor. When the consignor has an onboarded Connect
// account a real Stripe transfer is sent; otherwise the payout is recorded as
// pending so the balance is still tracked (e.g. cash / external payout).
// US-1616 / C3: this moves the OWNER's money — require admin. Without this a
// read-only viewer with a stale X-Workspace-Owner could trigger transfers.
flipdeskConsignmentRoutes.post("/payouts", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const userId = tenantId(c);
  const body = await c.req.json().catch(() => ({}));

  const consignorId = typeof body.consignor_id === "string" ? body.consignor_id : "";
  if (!consignorId) return c.json({ error: "consignor_id is required" }, 400);

  // C5: dollars become integer cents exactly once; the ledger stores
  // cents/100 and Stripe gets the same cents, so the two cannot drift.
  const cents = parseAmountCents(body.amount);
  if (cents === null) {
    return c.json({ error: "amount must be a positive dollar amount with at most two decimals, up to $1,000,000.00" }, 400);
  }
  const amount = cents / 100;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, FIELD_CAPS.notes) || null : null;
  const override = body.override === true;
  if (override && !note) {
    return c.json({ error: "Add a note saying why you are paying more than is owed." }, 400);
  }

  const consignor = await loadConsignorOwned(userId, consignorId);
  if (!consignor) return c.json({ error: "Consignor not found" }, 404);

  // C5: never pay more than is owed after what is already paid or in flight.
  const { data: pnl, error: pnlErr } = await supabaseAdmin
    .from("consignor_pnl")
    .select("consignor_share, payouts_paid, payouts_pending")
    .eq("consignor_id", consignorId)
    .eq("user_id", userId)
    .maybeSingle();
  if (pnlErr) return failSafe(c, 500, "Couldn't check what is owed.", pnlErr, "consignment.payouts.pnl");
  const row = (pnl ?? {}) as { consignor_share?: number; payouts_paid?: number; payouts_pending?: number };
  const availableCents = Math.max(
    toCents(row.consignor_share) - toCents(row.payouts_paid) - toCents(row.payouts_pending),
    0,
  );
  if (cents > availableCents && !override) {
    return c.json(
      {
        error: `That is more than you owe ${consignor.name} after payouts already queued.`,
        available: availableCents / 100,
      },
      409,
    );
  }

  // If a sale_id / inventory_item_id is supplied, confirm it belongs to the caller.
  let saleId: string | null = null;
  if (typeof body.sale_id === "string" && body.sale_id) {
    const { data: sale } = await supabaseAdmin
      .from("sales")
      .select("id")
      .eq("id", body.sale_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!sale) return c.json({ error: "Sale not found" }, 404);
    saleId = sale.id;
  }
  let itemId: string | null = null;
  if (typeof body.inventory_item_id === "string" && body.inventory_item_id) {
    const { data: item } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("id", body.inventory_item_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!item) return c.json({ error: "Item not found" }, 404);
    itemId = item.id;
  }

  // Insert the ledger row first (as pending) so the payout is always tracked
  // even if the Stripe transfer below fails.
  const { data: payout, error: insertErr } = await supabaseAdmin
    .from("consignor_payouts")
    .insert({
      user_id: userId,
      consignor_id: consignorId,
      sale_id: saleId,
      inventory_item_id: itemId,
      amount,
      status: "pending",
      note,
    })
    .select("*")
    .single();
  if (insertErr || !payout) {
    return failSafe(c, 500, "Could not record that payout.", insertErr ?? "no row", "consignment.payouts.insert");
  }

  const accountId = consignor.stripe_connect_account_id as string | null;
  const payoutsEnabled = Boolean(consignor.payouts_enabled);

  // No Connect account / not onboarded → leave as pending (manual/cash payout).
  if (!accountId || !payoutsEnabled) {
    return c.json({ payout, transferred: false });
  }

  const stripe = getStripe();
  if (!stripe) {
    return c.json({ payout, transferred: false });
  }

  let transferId: string;
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: cents,
        currency: "usd",
        destination: accountId,
        metadata: {
          consignor_id: consignorId,
          user_id: userId,
          payout_id: payout.id,
        },
      },
      { idempotencyKey: `consignor_payout_${payout.id}` },
    );
    transferId = transfer.id;
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Transfer failed";
    console.error(`[consignment.payouts.transfer] ${redactError(err)}`);
    await supabaseAdmin
      .from("consignor_payouts")
      .update({ status: "failed", error: raw.slice(0, 1000) })
      .eq("id", payout.id)
      .eq("user_id", userId);
    return c.json({ error: stripeTransferErrorCopy(err), payout_id: payout.id }, 502);
  }

  const { data: updated, error: paidErr } = await supabaseAdmin
    .from("consignor_payouts")
    .update({
      status: "paid",
      stripe_transfer_id: transferId,
      paid_at: new Date().toISOString(),
    })
    .eq("id", payout.id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (paidErr) {
    // The money moved; the ledger did not follow. Say so loudly and hand back
    // the transfer id so the row can be fixed by hand.
    console.error(`[consignment.payouts.paid_writeback] ${redactError(paidErr)}`);
    void emitOpsEvent("consignor.payout_ledger_stale", "critical", {
      title: "Consignor payout sent but the ledger row is still pending",
      source: "consignment.payouts",
      actorUserId: userId,
      data: { payout_id: payout.id, transfer_id: transferId, consignor_id: consignorId },
    });
    return c.json({ payout, transferred: true, transfer_id: transferId, ledger_updated: false });
  }
  return c.json({ payout: updated ?? payout, transferred: true, transfer_id: transferId });
});

// PATCH /payouts/:id — C7: settle a MANUAL payout by hand. mark_paid records a
// cash or check payout as paid; cancel drops one that will not happen. Auto
// rows belong to the engine and are refused.
flipdeskConsignmentRoutes.patch("/payouts/:id", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const userId = tenantId(c);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Payout not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const action = body.action;
  if (action !== "mark_paid" && action !== "cancel") {
    return c.json({ error: "action must be mark_paid or cancel" }, 400);
  }

  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("consignor_payouts")
    .select("id, status, source, note")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load that payout.", loadErr, "consignment.payouts.patch.load");
  if (!existing) return c.json({ error: "Payout not found" }, 404);
  const row = existing as { id: string; status: string; source: string | null; note: string | null };
  if (row.source === "auto") {
    return c.json({ error: "Automatic payouts are settled by Stripe, not by hand." }, 409);
  }
  if (row.status !== "pending" && row.status !== "failed") {
    return c.json({ error: `This payout is already ${row.status}.` }, 409);
  }

  let patch: Record<string, unknown>;
  if (action === "mark_paid") {
    const paidAt = typeof body.paid_at === "string" && Number.isFinite(Date.parse(body.paid_at))
      ? new Date(body.paid_at).toISOString()
      : new Date().toISOString();
    const method = typeof body.method === "string" ? body.method.trim().slice(0, 40) : "";
    const reference = typeof body.reference === "string" ? body.reference.trim().slice(0, 120) : "";
    const extra = [method && `Paid by ${method}`, reference && `ref ${reference}`].filter(Boolean).join(", ");
    const note = [row.note, extra].filter(Boolean).join(" | ").slice(0, FIELD_CAPS.notes) || null;
    patch = { status: "paid", paid_at: paidAt, note, error: null };
  } else {
    patch = { status: "canceled" };
  }

  // Sequential .eq() filters (US-1552: never .or() on a mutation). The status
  // filter makes a racing second click update nothing.
  const { data: updated, error } = await supabaseAdmin
    .from("consignor_payouts")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .eq("source", "manual")
    .eq("status", row.status)
    .select("*")
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update that payout.", error, "consignment.payouts.patch");
  if (!updated) return c.json({ error: "That payout changed. Refresh and try again." }, 409);
  return c.json({ payout: updated });
});
