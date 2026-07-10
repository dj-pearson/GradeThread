// US-1825: wardrobe portfolio — closet item add/remove with ownership verification.
//
// Personal /api/buyer/* route (scoped by c.get("userId"), no workspace). Three
// add sources, each ownership-gated server-side before insert (a buyer can never
// closet an item they don't own):
//   • manual      — no link, just attributes; always allowed.
//   • certificate — the owner GRADED it (grade_reports→submissions.user_id) OR
//                   BOUGHT it (buyer_purchases.certificate_id, US-1811).
//   • passport    — the owner is a linked participant in the garment's chain
//                   (garment_events→owner_nodes.linked_user_id, US-1105).
// Dedup is the partial unique indexes (00420): re-adding a cert/garment merges.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { getPortfolioValuation } from "../lib/portfolio-valuation-db.ts";
import { computePortfolioTotals } from "../lib/portfolio-valuation.ts";
import { buildClosetCsv, type ClosetExportRow, inventoryFromCloset } from "../lib/closet-export.ts";

type BuyerEnv = { Variables: { userId: string } };
export const buyerClosetRoutes = new Hono<BuyerEnv>();

// US-1826: portfolio valuation — each closet item's current-value estimate +
// portfolio totals (gain/loss vs cost basis). Cached + TTL-refreshed. Scoped by
// user_id (US-268).
buyerClosetRoutes.get("/closet/valuation", async (c) => {
  const userId = c.get("userId");
  try {
    const valuations = await getPortfolioValuation(userId);
    const totals = computePortfolioTotals(
      valuations.map((v) => ({ estimateCents: v.estimate_cents, costBasisCents: v.cost_basis_cents })),
    );
    return c.json({ valuations, totals });
  } catch (err) {
    console.error("[buyer-closet] valuation failed:", err);
    return c.json({ error: "Could not value your portfolio." }, 500);
  }
});

// US-1828: insurance-ready CSV export of the owned closet + certified grades +
// current estimated values. Scoped by user_id (US-268).
buyerClosetRoutes.get("/closet/export.csv", async (c) => {
  const userId = c.get("userId");
  const { data: items, error } = await supabaseAdmin
    .from("closet_items")
    .select("id, brand, garment_type, size, condition_grade, certificate_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: "Could not load your closet." }, 500);

  let valById = new Map<string, { estimate_cents: number | null; cost_basis_cents: number | null }>();
  try {
    const vals = await getPortfolioValuation(userId);
    valById = new Map(vals.map((v) => [v.closet_item_id, v]));
  } catch { /* export still works without valuations */ }

  const rows: ClosetExportRow[] = (items ?? []).map((raw) => {
    const it = raw as {
      id: string;
      brand: string | null;
      garment_type: string | null;
      size: string | null;
      condition_grade: number | null;
      certificate_id: string | null;
    };
    const v = valById.get(it.id);
    return {
      brand: it.brand,
      garment_type: it.garment_type,
      size: it.size,
      condition_grade: it.condition_grade,
      certificate_id: it.certificate_id,
      estimateCents: v?.estimate_cents ?? null,
      costBasisCents: v?.cost_basis_cents ?? null,
    };
  });

  return new Response(buildClosetCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gradethread-closet.csv"',
    },
  });
});

// US-1828: one-click "list this" — promote a closet item into FlipDesk inventory,
// pre-filled with grade + cert + a suggested price. Ownership FIRST (foreign id →
// 0 rows → 404). Idempotent via closet_items.promoted_item_id.
buyerClosetRoutes.post("/closet/:id/list", async (c) => {
  const userId = c.get("userId");
  const closetId = c.req.param("id");

  const { data: item } = await supabaseAdmin
    .from("closet_items")
    .select("id, brand, garment_type, size, condition_grade, certificate_id, title, notes, promoted_item_id")
    .eq("id", closetId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item) return c.json({ error: "Closet item not found." }, 404);
  const cl = item as {
    id: string;
    brand: string | null;
    garment_type: string | null;
    size: string | null;
    condition_grade: number | null;
    certificate_id: string | null;
    title: string | null;
    notes: string | null;
    promoted_item_id: string | null;
  };

  // Idempotent: already promoted → return the existing listing.
  if (cl.promoted_item_id) {
    return c.json({ ok: true, inventory_item_id: cl.promoted_item_id, alreadyListed: true });
  }

  // Account role (US-1796): a buyer with no paid FlipDesk plan is prompted to set
  // up selling. We still create the draft (it's theirs) and flag onboarding.
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan")
    .eq("id", userId)
    .maybeSingle();
  const plan = (userRow as { flipdesk_plan: string | null } | null)?.flipdesk_plan ?? null;
  const sellerOnboarding = !plan || plan === "free";

  // Suggested price from the valuation cache (best-effort).
  let estimateCents: number | null = null;
  try {
    const { data: val } = await supabaseAdmin
      .from("closet_item_valuations")
      .select("estimate_cents")
      .eq("closet_item_id", cl.id)
      .eq("user_id", userId)
      .maybeSingle();
    estimateCents = (val as { estimate_cents: number | null } | null)?.estimate_cents ?? null;
  } catch { /* no valuation → seller sets the price */ }

  const draft = inventoryFromCloset(cl, estimateCents);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("inventory_items")
    .insert({ user_id: userId, ...draft } as never)
    .select("id")
    .single();
  if (insErr) {
    console.error("[buyer-closet] list promotion failed:", insErr);
    return c.json({ error: "Could not create the listing draft." }, 500);
  }
  const inventoryItemId = (inserted as { id: string }).id;

  // Link back (idempotency + "Listed" state). Scoped by user_id.
  await supabaseAdmin
    .from("closet_items")
    .update({ promoted_item_id: inventoryItemId } as never)
    .eq("id", cl.id)
    .eq("user_id", userId);

  return c.json({ ok: true, inventory_item_id: inventoryItemId, sellerOnboarding });
});

export const CLOSET_SOURCES = ["certificate", "passport", "manual"] as const;
export type ClosetSource = (typeof CLOSET_SOURCES)[number];

export function isClosetSource(v: unknown): v is ClosetSource {
  return typeof v === "string" && (CLOSET_SOURCES as readonly string[]).includes(v);
}

/** Clean an optional short text field to a trimmed string or null. Pure. */
export function cleanText(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Parse a condition grade (1.0–10.0) or null. Pure. */
export function parseGrade(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n * 10) / 10 : null;
}

// Does `userId` own the certificate? Graded it OR bought+linked it. Returns the
// display snapshot (brand/title) when owned, or null when not owned / not found.
async function certOwnership(
  userId: string,
  certificateId: string,
): Promise<{ brand: string | null; title: string | null } | null> {
  // 1) The owner GRADED it: grade_reports (public id) → submissions.user_id.
  const { data: rep } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id, submissions!inner(user_id, brand, title)")
    .eq("certificate_id", certificateId)
    .maybeSingle();
  if (rep) {
    const raw = (rep as { submissions: unknown }).submissions;
    const sub = (Array.isArray(raw) ? raw[0] : raw) as
      | { user_id: string; brand: string | null; title: string | null }
      | null
      | undefined;
    if (sub && sub.user_id === userId) return { brand: sub.brand, title: sub.title };
  }
  // 2) The owner BOUGHT it: a linked buyer_purchase (US-1811), scoped by user_id.
  const { data: purchase } = await supabaseAdmin
    .from("buyer_purchases")
    .select("brand, title")
    .eq("certificate_id", certificateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (purchase) {
    return { brand: (purchase as { brand: string | null }).brand, title: (purchase as { title: string | null }).title };
  }
  return null;
}

// Is `userId` a linked participant in the garment's ownership chain (US-1105)?
// Two steps (robust vs a PostgREST embed FK-name): the user's linked nodes, then
// whether any of them acted on this garment.
async function passportOwnership(userId: string, garmentId: string): Promise<boolean> {
  const { data: nodes } = await supabaseAdmin
    .from("owner_nodes")
    .select("id")
    .eq("linked_user_id", userId);
  const nodeIds = (nodes ?? []).map((n) => (n as { id: string }).id);
  if (nodeIds.length === 0) return false;
  const { data: events } = await supabaseAdmin
    .from("garment_events")
    .select("id")
    .eq("garment_id", garmentId)
    .in("actor_node_id", nodeIds)
    .limit(1);
  return Array.isArray(events) && events.length > 0;
}

buyerClosetRoutes.post("/closet", async (c) => {
  const userId = c.get("userId");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  if (!isClosetSource(body.source)) {
    return c.json({ error: "Invalid source." }, 400);
  }
  const source = body.source;

  let certificateId: string | null = null;
  let garmentId: string | null = null;
  let brand = cleanText(body.brand);
  let title = cleanText(body.title);

  if (source === "certificate") {
    certificateId = cleanText(body.certificate_id, 100);
    if (!certificateId) return c.json({ error: "certificate_id is required." }, 400);
    const owned = await certOwnership(userId, certificateId);
    if (!owned) return c.json({ error: "You don't own that certificate." }, 403);
    brand = owned.brand ?? brand;
    title = owned.title ?? title;
  } else if (source === "passport") {
    garmentId = cleanText(body.garment_id, 100);
    if (!garmentId) return c.json({ error: "garment_id is required." }, 400);
    if (!(await passportOwnership(userId, garmentId))) {
      return c.json({ error: "You don't own that passport item." }, 403);
    }
  }

  const row = {
    user_id: userId,
    source,
    certificate_id: certificateId,
    garment_id: garmentId,
    brand,
    garment_type: cleanText(body.garment_type),
    size: cleanText(body.size, 50),
    condition_grade: parseGrade(body.condition_grade),
    title,
    notes: cleanText(body.notes, 500),
  };

  // Merge on the partial-unique link key (re-adding a cert/garment updates it);
  // manual entries have no conflict target so they insert fresh.
  const onConflict = source === "certificate" ? "user_id,certificate_id" : source === "passport" ? "user_id,garment_id" : undefined;
  const q = supabaseAdmin.from("closet_items");
  const { data, error } = onConflict
    ? await q.upsert(row as never, { onConflict }).select("*").single()
    : await q.insert(row as never).select("*").single();
  if (error) return c.json({ error: "Could not add to your closet." }, 500);
  return c.json({ ok: true, item: data });
});

buyerClosetRoutes.delete("/closet/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Scoped by user_id: a foreign id deletes 0 rows (idempotent, no cross-tenant).
  const { error } = await supabaseAdmin
    .from("closet_items")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return c.json({ error: "Could not remove the item." }, 500);
  return c.json({ ok: true });
});
