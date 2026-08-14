// US-1830: demand board — buyer want CRUD + on-create matching.
//
// Personal /api/buyer/* route (scoped by c.get("userId")). READS of own wants +
// matches go direct via owner RLS; WRITES go through the edge so criteria are
// validated + the cross-tenant match query runs service-role. On create we run
// one matching pass and record want_matches (US-1830).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  hasCriteria,
  normalizeWantInput,
  partitionCategories,
} from "../lib/demand-board.ts";
import { computeWantMatches } from "../lib/demand-board-db.ts";
import { requireBuyerFeature } from "../lib/buyer-entitlements.ts";

type BuyerEnv = { Variables: { userId: string } };
export const buyerWantsRoutes = new Hono<BuyerEnv>();

/** How many matches the view returns. A want that matched more than this is
 *  telling the buyer to narrow it, not to scroll. */
const MAX_MATCHES_SHOWN = 50;

const MAX_ACTIVE_WANTS = 25;

// DELIBERATELY UNGATED, both here and on DELETE below. A buyer who downgrades
// still owns the wants they created, and a 402 on read or delete would leave
// them unable to see or clean up their own data — the gate would have turned a
// billing state into data loss. The rule this follows: gate the paths that
// CREATE or CONSUME a paid feature, never the ones that read or remove what the
// buyer already has.
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
  // US-2359: the demand board is a Connoisseur feature and had no gate on any
  // of its four routes, so every tier had it. Gating the WRITE paths only is
  // deliberate — see the note above GET /wants.
  const gate = await requireBuyerFeature(c, "demandBoard");
  if (gate instanceof Response) return gate;
  const userId = c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const want = normalizeWantInput(body);

  // US-2552: a category outside the taxonomy can never match anything, because
  // matching is exact equality against submissions.garment_category. Storing it
  // would give the buyer a criterion that silently returns nothing forever, so
  // it is dropped here and HANDED BACK for the client to show.
  const { kept, ignored } = partitionCategories(want.categories);
  want.categories = kept;

  if (!hasCriteria(want)) {
    return c.json(
      {
        error: ignored.length > 0
          ? `We don't grade a category called "${ignored[0]}", so that want would never match. Pick one from the list.`
          : "Add at least one criterion (brand, category, keyword, grade, or price).",
        ignored_categories: ignored,
      },
      400,
    );
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
  return c.json({ ok: true, want_id: row.id, matched, ignored_categories: ignored });
});


// GET /wants/:id/matches — US-2552: what this want actually matched.
//
// Posting a want returned a toast with a count and nothing else: no way to see
// what matched, then or ever. The matches were already being recorded (the
// want_matches table, and the cron notifies on new ones) — there was simply no
// way to look at them.
//
// Reads are NOT gated on the demandBoard entitlement, same as GET /wants: a
// buyer whose plan lapsed still owns what they posted, and gating a read would
// turn a billing state into data they can no longer see.
buyerWantsRoutes.get("/wants/:id/matches", async (c) => {
  const userId = c.get("userId");
  const wantId = c.req.param("id");

  // US-268: the want must belong to the caller. Scoping the MATCH query by
  // buyer_user_id as well is belt-and-braces, not redundancy — want_matches is
  // written by a cron on the service-role client.
  const { data: want } = await supabaseAdmin
    .from("buyer_wants")
    .select("id")
    .eq("id", wantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!want) return c.json({ error: "Want not found" }, 404);

  const { data: matches, error } = await supabaseAdmin
    .from("want_matches")
    .select("certificate_id, created_at")
    .eq("want_id", wantId)
    .eq("buyer_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_MATCHES_SHOWN);
  if (error) return c.json({ error: "Could not load matches." }, 500);

  const certIds = (matches ?? []).map((m) => (m as { certificate_id: string }).certificate_id);
  if (certIds.length === 0) return c.json({ matches: [] });

  // Public-safe fields only — this is the same information any visitor sees on
  // /cert/:id, reached through the report + its parent submission.
  const { data: reports } = await supabaseAdmin
    .from("grade_reports")
    .select("certificate_id, overall_score, grade_tier, submissions!inner(title, brand)")
    .in("certificate_id", certIds);
  const byCert = new Map(
    ((reports ?? []) as Array<{
      certificate_id: string;
      overall_score: number;
      grade_tier: string;
      submissions: { title: string | null; brand: string | null } | Array<{ title: string | null; brand: string | null }>;
    }>).map((r) => {
      const sub = Array.isArray(r.submissions) ? r.submissions[0] : r.submissions;
      return [r.certificate_id, {
        overallScore: r.overall_score,
        gradeTier: r.grade_tier,
        title: sub?.title ?? null,
        brand: sub?.brand ?? null,
      }];
    }),
  );

  return c.json({
    matches: certIds.map((id, i) => ({
      certificateId: id,
      matchedAt: (matches ?? [])[i] ? ((matches ?? [])[i] as { created_at: string }).created_at : null,
      ...(byCert.get(id) ?? { overallScore: null, gradeTier: null, title: null, brand: null }),
    })),
  });
});

// Manage a want's lifecycle (expire / re-activate / mark fulfilled).
buyerWantsRoutes.patch("/wants/:id", async (c) => {
  const gate = await requireBuyerFeature(c, "demandBoard");
  if (gate instanceof Response) return gate;
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

// Ungated on purpose — see the note above GET /wants.
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
