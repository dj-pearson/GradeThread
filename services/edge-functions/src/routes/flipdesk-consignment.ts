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

function getStripe(): Stripe | null {
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

function clampSplit(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
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
flipdeskConsignmentRoutes.get("/consignors", async (c) => {
  const userId = tenantId(c);

  const { data: consignors, error } = await supabaseAdmin
    .from("consignors")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load consignors.", error, "consignment.list");

  const { data: pnl } = await supabaseAdmin
    .from("consignor_pnl")
    .select("*")
    .eq("user_id", userId);

  const pnlById = new Map<string, Record<string, unknown>>();
  for (const row of pnl ?? []) {
    pnlById.set((row as { consignor_id: string }).consignor_id, row as Record<string, unknown>);
  }

  const merged = (consignors ?? []).map((row) => ({
    ...row,
    pnl: pnlById.get((row as { id: string }).id) ?? null,
  }));

  return c.json({ consignors: merged });
});

// POST /consignors — create a consignor.
flipdeskConsignmentRoutes.post("/consignors", async (c) => {
  const userId = tenantId(c);
  const body = await c.req.json().catch(() => ({}));

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const split = clampSplit(body.default_split_pct ?? body.split_pct);

  const { data, error } = await supabaseAdmin
    .from("consignors")
    .insert({
      user_id: userId,
      name,
      contact_email:
        typeof body.contact_email === "string" ? body.contact_email.trim() || null : null,
      contact_phone:
        typeof body.contact_phone === "string" ? body.contact_phone.trim() || null : null,
      default_split_pct: split ?? 50,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    })
    .select("*")
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the consignor.", error, "consignment.create");

  return c.json({ consignor: data }, 201);
});

// PATCH /consignors/:id — update name / contact / split / status / notes.
flipdeskConsignmentRoutes.patch("/consignors/:id", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if ("contact_email" in body) {
    patch.contact_email =
      typeof body.contact_email === "string" ? body.contact_email.trim() || null : null;
  }
  if ("contact_phone" in body) {
    patch.contact_phone =
      typeof body.contact_phone === "string" ? body.contact_phone.trim() || null : null;
  }
  if ("notes" in body) patch.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  if ("default_split_pct" in body || "split_pct" in body) {
    const split = clampSplit(body.default_split_pct ?? body.split_pct);
    if (split === null) return c.json({ error: "default_split_pct must be 0-100" }, 400);
    patch.default_split_pct = split;
  }
  if (typeof body.status === "string" && ["active", "paused", "archived"].includes(body.status)) {
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
  if (error) return failSafe(c, 500, "Couldn't update the consignor.", error, "consignment.update");

  return c.json({ consignor: data });
});

// POST /consignors/:id/intake — record the consignment-agreement e-signature.
flipdeskConsignmentRoutes.post("/consignors/:id/intake", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const signatureName = typeof body.signature_name === "string" ? body.signature_name.trim() : "";
  if (!signatureName) return c.json({ error: "signature_name is required" }, 400);

  const { data, error } = await supabaseAdmin
    .from("consignors")
    .update({
      intake_signed_at: new Date().toISOString(),
      intake_signature_name: signatureName,
      intake_agreement_version:
        typeof body.agreement_version === "string" && body.agreement_version.trim()
          ? body.agreement_version.trim()
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
flipdeskConsignmentRoutes.post("/consignors/:id/connect", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  let accountId = existing.stripe_connect_account_id as string | null;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: (existing.contact_email as string | null) ?? undefined,
      capabilities: { transfers: { requested: true } },
      metadata: { consignor_id: id, user_id: userId },
    });
    accountId = account.id;
    await supabaseAdmin
      .from("consignors")
      .update({ stripe_connect_account_id: accountId })
      .eq("id", id)
      .eq("user_id", userId);
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${siteUrl()}/dashboard/flipdesk/consignment?connect=refresh&consignor=${id}`,
    return_url: `${siteUrl()}/dashboard/flipdesk/consignment?connect=done&consignor=${id}`,
    type: "account_onboarding",
  });

  return c.json({ url: link.url });
});

// GET /consignors/:id/connect/status — refresh payouts_enabled from Stripe.
flipdeskConsignmentRoutes.get("/consignors/:id/connect/status", async (c) => {
  const userId = tenantId(c);
  const id = c.req.param("id");
  const existing = await loadConsignorOwned(userId, id);
  if (!existing) return c.json({ error: "Consignor not found" }, 404);

  const accountId = existing.stripe_connect_account_id as string | null;
  if (!accountId) return c.json({ connected: false, payouts_enabled: false });

  const stripe = getStripe();
  if (!stripe) return c.json({ error: "Payments are not configured" }, 503);

  const account = await stripe.accounts.retrieve(accountId);
  const enabled = Boolean(account.payouts_enabled && account.charges_enabled);
  if (enabled !== Boolean(existing.payouts_enabled)) {
    await supabaseAdmin
      .from("consignors")
      .update({ payouts_enabled: enabled })
      .eq("id", id)
      .eq("user_id", userId);
  }

  return c.json({
    connected: true,
    payouts_enabled: enabled,
    details_submitted: Boolean(account.details_submitted),
  });
});

// ── Payouts ─────────────────────────────────────────────────────

// GET /payouts — payout ledger (optionally ?consignor_id=).
flipdeskConsignmentRoutes.get("/payouts", async (c) => {
  const userId = tenantId(c);
  const consignorId = c.req.query("consignor_id");

  let query = supabaseAdmin
    .from("consignor_payouts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (consignorId) query = query.eq("consignor_id", consignorId);

  const { data, error } = await query;
  if (error) return failSafe(c, 500, "Couldn't load payouts.", error, "consignment.payouts.list");
  return c.json({ payouts: data ?? [] });
});

// POST /payouts — pay a consignor. When the consignor has an onboarded Connect
// account a real Stripe transfer is sent; otherwise the payout is recorded as
// pending so the balance is still tracked (e.g. cash / external payout).
// US-1616 / C3: this moves the OWNER's money — require admin. Without this a
// read-only viewer with a stale X-Workspace-Owner could trigger transfers.
flipdeskConsignmentRoutes.post("/payouts", async (c) => {
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }
  const userId = tenantId(c);
  const body = await c.req.json().catch(() => ({}));

  const consignorId = typeof body.consignor_id === "string" ? body.consignor_id : "";
  if (!consignorId) return c.json({ error: "consignor_id is required" }, 400);

  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "amount must be a positive number" }, 400);
  }

  const consignor = await loadConsignorOwned(userId, consignorId);
  if (!consignor) return c.json({ error: "Consignor not found" }, 404);

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
      note: typeof body.note === "string" ? body.note.trim() || null : null,
    })
    .select("*")
    .single();
  if (insertErr || !payout) {
    return c.json(
      {
        error: "Could not record that payout.",
        detail: insertErr?.message ?? null,
      },
      500,
    );
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

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(amount * 100),
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
    const { data: updated } = await supabaseAdmin
      .from("consignor_payouts")
      .update({
        status: "paid",
        stripe_transfer_id: transfer.id,
        paid_at: new Date().toISOString(),
      })
      .eq("id", payout.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    return c.json({ payout: updated ?? payout, transferred: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    await supabaseAdmin
      .from("consignor_payouts")
      .update({ status: "failed", error: message })
      .eq("id", payout.id)
      .eq("user_id", userId);
    return c.json({ error: message, payout_id: payout.id }, 502);
  }
});
