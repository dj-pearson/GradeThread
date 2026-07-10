// US-1830: demand board — buyer want CRUD + on-create matching.
//
// Personal /api/buyer/* route (scoped by c.get("userId")). READS of own wants +
// matches go direct via owner RLS; WRITES go through the edge so criteria are
// validated + the cross-tenant match query runs service-role. On create we run
// one matching pass and record want_matches (US-1830).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { hasCriteria, normalizeWantInput } from "../lib/demand-board.ts";
import { computeWantMatches } from "../lib/demand-board-db.ts";

type BuyerEnv = { Variables: { userId: string } };
export const buyerWantsRoutes = new Hono<BuyerEnv>();

const MAX_ACTIVE_WANTS = 25;

buyerWantsRoutes.get("/wants", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("buyer_wants")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: "Could not load your wants." }, 500);
  return c.json({ wants: data ?? [] });
});

buyerWantsRoutes.post("/wants", async (c) => {
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const want = normalizeWantInput(body);
  if (!hasCriteria(want)) {
    return c.json({ error: "Add at least one criterion (brand, category, keyword, grade, or price)." }, 400);
  }

  // Anti-abuse (US-1832): cap active wants per buyer so the board can't be spammed.
  const { count } = await supabaseAdmin
    .from("buyer_wants")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE_WANTS) {
    return c.json({ error: `You can have up to ${MAX_ACTIVE_WANTS} active wants. Expire one first.` }, 429);
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("buyer_wants")
    .insert({ user_id: userId, ...want } as never)
    .select("id, user_id, brands, categories, keywords, min_grade, max_price_cents")
    .single();
  if (error) {
    console.error("[buyer-wants] insert failed:", error);
    return c.json({ error: "Could not save your want." }, 500);
  }
  const row = inserted as {
    id: string;
    user_id: string;
    brands: string[];
    categories: string[];
    keywords: string[];
    min_grade: number | null;
    max_price_cents: number | null;
  };

  // Run one matching pass now (best-effort — never blocks the create).
  const { matched } = await computeWantMatches(row);
  return c.json({ ok: true, want_id: row.id, matched });
});

// Manage a want's lifecycle (expire / re-activate / mark fulfilled).
buyerWantsRoutes.patch("/wants/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  let body: { status?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  if (body.status !== "active" && body.status !== "expired" && body.status !== "fulfilled") {
    return c.json({ error: "status must be active | expired | fulfilled." }, 400);
  }
  const { data, error } = await supabaseAdmin
    .from("buyer_wants")
    .update({ status: body.status } as never)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: "Could not update that want." }, 500);
  if (!data) return c.json({ error: "Want not found." }, 404);
  return c.json({ ok: true });
});

buyerWantsRoutes.delete("/wants/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Ownership-scoped delete — a foreign id matches 0 rows (US-268).
  const { error } = await supabaseAdmin
    .from("buyer_wants")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return c.json({ error: "Could not remove that want." }, 500);
  return c.json({ ok: true });
});
