// US-3299: admin CRUD for sale campaigns.
//
// Mounted at /api/admin/discounts — the /api/admin/* middleware (auth +
// adminAuthMiddleware, incl. the AAL2/MFA gate) already protects it. Mutations
// additionally require super_admin + a fresh MFA step-up, exactly like the plan
// editor next to it: this moves money.
//
// A campaign is only real once its Stripe coupon exists. Every write path here
// mints or re-mints that coupon and records the outcome on the row, and a row
// with a null stripe_coupon_id is invisible to the public read policy and is
// never applied at checkout — a discount a card advertises and checkout refuses
// is worse than no sale.
//
// Documented SQL fallback (if the UI is unavailable), to END a live sale early:
//   update public.discount_campaigns set enabled = false where id = '...';

import { type Context, Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  clearDiscountCache,
  couponNeedsRemint,
  deleteCampaignCoupon,
  DISCOUNT_SELECT_COLS,
  syncCampaignCoupon,
} from "../lib/discount-store.ts";
import { DISCOUNT_TARGET_KINDS, type DiscountTarget } from "../lib/discount-campaigns.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminDiscountsRoutes = new Hono<AdminEnv>();

adminDiscountsRoutes.use("*", requireScope("ops:write"));

const KIND_SET = new Set<string>(DISCOUNT_TARGET_KINDS);
const INTERVALS = new Set(["monthly", "yearly"]);

// ── GET / ─────────────────────────────────────────────────────────
// Every campaign including expired and unsynced ones, newest window first. The
// admin table needs the whole history; the public read policy does not.
adminDiscountsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .order("starts_at", { ascending: false });
  if (error) return jsonError(c, 500, "Failed to load discount campaigns");
  return c.json({ campaigns: data ?? [] });
});

// ── Validation ────────────────────────────────────────────────────

export interface ValidatedCampaign {
  name: string;
  description: string | null;
  discount_type: "percent" | "amount";
  percent_off: number | null;
  amount_off_cents: number | null;
  starts_at: string;
  ends_at: string;
  enabled: boolean;
  targets: DiscountTarget[];
  applies_to_all: boolean;
}

function parseTargets(
  raw: unknown,
): { ok: true; value: DiscountTarget[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "targets must be an array" };
  // 200 is far above the ~25 real packages and still bounds the row.
  if (raw.length > 200) return { ok: false, error: "targets is limited to 200 entries" };

  const out: DiscountTarget[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "each target must be an object" };
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.kind !== "string" || !KIND_SET.has(t.kind)) {
      return { ok: false, error: `target.kind must be one of ${DISCOUNT_TARGET_KINDS.join(", ")}` };
    }
    if (typeof t.key !== "string" && typeof t.key !== "number") {
      return { ok: false, error: "target.key must be a string" };
    }
    const key = String(t.key).trim().slice(0, 64);
    if (!key) return { ok: false, error: "target.key must be non-empty" };

    let interval: "monthly" | "yearly" | undefined;
    if (t.interval !== undefined && t.interval !== null && t.interval !== "") {
      if (typeof t.interval !== "string" || !INTERVALS.has(t.interval)) {
        return { ok: false, error: "target.interval must be monthly or yearly" };
      }
      interval = t.interval as "monthly" | "yearly";
    }

    // Dedupe: the same package ticked twice would double it in the admin summary
    // and change nothing at checkout, which reads as a bug.
    const sig = `${t.kind}|${key}|${interval ?? ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);

    out.push(interval ? { kind: t.kind as DiscountTarget["kind"], key, interval } : {
      kind: t.kind as DiscountTarget["kind"],
      key,
    });
  }
  return { ok: true, value: out };
}

export function validateCampaign(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedCampaign } | { ok: false; error: string } {
  if (typeof body.name !== "string" || !body.name.trim()) {
    return { ok: false, error: "name must be a non-empty string" };
  }
  // 40 is Stripe's cap on a coupon name. Truncating here rather than at mint time
  // keeps what the operator sees in admin and what a customer sees on the Stripe
  // invoice identical.
  const name = body.name.trim().slice(0, 40);

  const description = typeof body.description === "string" && body.description.trim()
    ? body.description.trim().slice(0, 200)
    : null;

  const discount_type = body.discount_type;
  if (discount_type !== "percent" && discount_type !== "amount") {
    return { ok: false, error: "discount_type must be percent or amount" };
  }

  let percent_off: number | null = null;
  let amount_off_cents: number | null = null;
  if (discount_type === "percent") {
    const pct = Number(body.percent_off);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return { ok: false, error: "percent_off must be greater than 0 and at most 100" };
    }
    // Two decimals is what the numeric(5,2) column stores; rounding here means the
    // preview in admin and the coupon in Stripe cannot disagree in the third place.
    percent_off = Math.round(pct * 100) / 100;
  } else {
    const cents = Number(body.amount_off_cents);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_00) {
      return { ok: false, error: "amount_off_cents must be a whole number of cents above 0" };
    }
    amount_off_cents = cents;
  }

  const startMs = Date.parse(String(body.starts_at));
  const endMs = Date.parse(String(body.ends_at));
  if (!Number.isFinite(startMs)) return { ok: false, error: "starts_at must be a valid date" };
  if (!Number.isFinite(endMs)) return { ok: false, error: "ends_at must be a valid date" };
  if (endMs <= startMs) return { ok: false, error: "ends_at must be after starts_at" };

  // Stripe's redeem_by is the coupon's own expiry, so a campaign ending in the
  // past could never be minted. Catching it here gives a readable error instead
  // of a Stripe rejection surfaced as stripe_sync_error.
  if (endMs <= Date.now()) {
    return { ok: false, error: "ends_at is in the past — this campaign could never run" };
  }

  const applies_to_all = body.applies_to_all === true;
  const parsed = parseTargets(body.targets ?? []);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!applies_to_all && parsed.value.length === 0) {
    return { ok: false, error: "Pick at least one package, or switch on All packages" };
  }

  return {
    ok: true,
    value: {
      name,
      description,
      discount_type,
      percent_off,
      amount_off_cents,
      starts_at: new Date(startMs).toISOString(),
      ends_at: new Date(endMs).toISOString(),
      enabled: body.enabled !== false,
      targets: applies_to_all ? [] : parsed.value,
      applies_to_all,
    },
  };
}

/**
 * super_admin plus a fresh MFA step-up, on every mutation. Returns the refusal to
 * hand straight back, or null to carry on.
 */
function guard(c: Context<AdminEnv>): Response | null {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit discounts." }, 403);
  }
  return requireStepUp(c);
}

// ── POST / ────────────────────────────────────────────────────────
// Create a campaign, then mint its Stripe coupon.
adminDiscountsRoutes.post("/", async (c) => {
  const blocked = guard(c);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const valid = validateCampaign(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const userId = c.get("userId");
  const { data: created, error } = await supabaseAdmin
    .from("discount_campaigns")
    .insert({ ...valid.value, created_by: userId, updated_by: userId } as never)
    .select(DISCOUNT_SELECT_COLS)
    .maybeSingle();
  if (error || !created) return jsonError(c, 500, "Failed to create discount campaign");

  const row = created as unknown as { id: string; revision: number };
  const after = await mintAndRecord(row.id, { ...valid.value, id: row.id, revision: row.revision });
  clearDiscountCache();

  await writeAuditLog(c, {
    action: "discount_campaign.create",
    targetType: "discount_campaign",
    targetId: row.id,
    before: null,
    after,
  });

  return c.json({ ok: true, campaign: after });
});

// ── PUT /:id ──────────────────────────────────────────────────────
// Full replace. A money-affecting edit re-mints the coupon and drops the old one.
adminDiscountsRoutes.put("/:id", async (c) => {
  const blocked = guard(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const valid = validateCampaign(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const { data: before } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Campaign not found");

  const prev = before as unknown as {
    discount_type: string;
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
    revision: number;
    stripe_coupon_id: string | null;
  };
  const remint = couponNeedsRemint(prev, valid.value) || !prev.stripe_coupon_id;
  const revision = remint ? prev.revision + 1 : prev.revision;

  const { data: updated, error } = await supabaseAdmin
    .from("discount_campaigns")
    .update({ ...valid.value, revision, updated_by: c.get("userId") } as never)
    .eq("id", id)
    .select(DISCOUNT_SELECT_COLS)
    .maybeSingle();
  if (error || !updated) return jsonError(c, 500, "Failed to update discount campaign");

  let after: unknown = updated;
  if (remint) {
    after = await mintAndRecord(id, { ...valid.value, id, revision });
    // Only after the replacement exists. Dropping it first would leave a window
    // where the campaign is live in the DB with a coupon that no longer exists.
    await deleteCampaignCoupon(prev.stripe_coupon_id);
  }
  clearDiscountCache();

  await writeAuditLog(c, {
    action: "discount_campaign.update",
    targetType: "discount_campaign",
    targetId: id,
    before,
    after,
  });

  return c.json({ ok: true, campaign: after });
});

// ── POST /:id/toggle ──────────────────────────────────────────────
// The kill switch. Deliberately its own route so ending a sale early does not go
// through full validation — a campaign whose end date has since passed still has
// to be switchable off.
adminDiscountsRoutes.post("/:id/toggle", async (c) => {
  const blocked = guard(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch { /* an empty body means "flip it" */ }

  const { data: before } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Campaign not found");

  const next = typeof body.enabled === "boolean"
    ? body.enabled
    : !(before as unknown as { enabled: boolean }).enabled;

  const { data: after, error } = await supabaseAdmin
    .from("discount_campaigns")
    .update({ enabled: next, updated_by: c.get("userId") } as never)
    .eq("id", id)
    .select(DISCOUNT_SELECT_COLS)
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to toggle discount campaign");

  clearDiscountCache();
  await writeAuditLog(c, {
    action: next ? "discount_campaign.enable" : "discount_campaign.disable",
    targetType: "discount_campaign",
    targetId: id,
    before,
    after,
  });

  return c.json({ ok: true, campaign: after });
});

// ── DELETE /:id ───────────────────────────────────────────────────
adminDiscountsRoutes.delete("/:id", async (c) => {
  const blocked = guard(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  const { data: before } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Campaign not found");

  const { error } = await supabaseAdmin.from("discount_campaigns").delete().eq("id", id);
  if (error) return jsonError(c, 500, "Failed to delete discount campaign");

  await deleteCampaignCoupon(
    (before as unknown as { stripe_coupon_id: string | null }).stripe_coupon_id,
  );
  clearDiscountCache();

  await writeAuditLog(c, {
    action: "discount_campaign.delete",
    targetType: "discount_campaign",
    targetId: id,
    before,
    after: null,
  });

  return c.json({ ok: true });
});

// ── POST /:id/resync ──────────────────────────────────────────────
// Retry a coupon that failed to mint (Stripe down, key rotated). Without this the
// only way out of a stripe_sync_error is a no-op edit.
adminDiscountsRoutes.post("/:id/resync", async (c) => {
  const blocked = guard(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  const { data: row } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!row) return jsonError(c, 404, "Campaign not found");

  const prev = row as unknown as {
    id: string;
    name: string;
    discount_type: "percent" | "amount";
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
    revision: number;
    stripe_coupon_id: string | null;
  };

  // A fresh revision, so the idempotency key differs from the attempt that failed.
  const revision = prev.revision + 1;
  await supabaseAdmin
    .from("discount_campaigns")
    .update({ revision } as never)
    .eq("id", id);

  const after = await mintAndRecord(id, { ...prev, revision });
  await deleteCampaignCoupon(prev.stripe_coupon_id);
  clearDiscountCache();

  await writeAuditLog(c, {
    action: "discount_campaign.resync",
    targetType: "discount_campaign",
    targetId: id,
    before: row,
    after,
  });

  return c.json({ ok: true, campaign: after });
});

// ── shared ────────────────────────────────────────────────────────

/**
 * Mint the coupon and write the outcome onto the row.
 *
 * A failure is RECORDED, not thrown. The campaign row survives with a null
 * stripe_coupon_id and a readable stripe_sync_error, which the admin table shows
 * as "Not synced" and the resync route retries. Rolling the row back instead
 * would lose the operator's work over a transient Stripe outage.
 */
async function mintAndRecord(
  id: string,
  campaign: {
    id: string;
    name: string;
    discount_type: "percent" | "amount";
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
    revision: number;
  },
): Promise<unknown> {
  const sync = await syncCampaignCoupon(campaign);
  const { data } = await supabaseAdmin
    .from("discount_campaigns")
    .update({
      stripe_coupon_id: sync.couponId,
      stripe_sync_error: sync.error,
    } as never)
    .eq("id", id)
    .select(DISCOUNT_SELECT_COLS)
    .maybeSingle();
  return data;
}
