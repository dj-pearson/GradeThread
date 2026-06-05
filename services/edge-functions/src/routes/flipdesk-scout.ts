// ScoutAI — the Condition Arbitrage Engine (US-615/616/617/619/620).
//
// "Grade what you don't own": a power seller pastes an eBay keyword/category
// search; ScoutAI grades each candidate listing from its OWN public photos
// (a private shadow grade — US-616), values it at that condition (US-610), and
// ranks by condition-adjusted margin (US-617) so "underpriced for its
// condition" deals rise to the top.
//
// Guardrails (US-620): shadow grades are PRIVATE to the requesting tenant — we
// never publish them or re-label the seller's listing; results are clearly an
// ESTIMATE, not a GradeThread certificate. Paid feature (compPulls gate, US-619)
// with atomic AI-quota reservation per candidate and a bounded candidate cap.
// Search uses the eBay APP token, so no user eBay connection is required.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { valueAtGrade } from "../lib/condition-value.ts";
import {
  rankCandidates,
  scoreCandidate,
  type ScoutCandidate,
} from "../lib/scout-scoring.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

export const flipdeskScoutRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// Hard cap on candidates graded per scan — bounds AI cost + eBay fan-out.
const MAX_CANDIDATES = 8;

flipdeskScoutRoutes.post("/", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // US-619: ScoutAI is a paid pro feature. compPulls unlocks on pro+ — the same
  // gate as condition-comp access, which is exactly what ScoutAI does.
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  let body: { categoryId?: unknown; q?: unknown; brand?: unknown; limit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  const q = typeof body.q === "string" ? body.q.trim() : undefined;
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const requested = typeof body.limit === "number" ? body.limit : MAX_CANDIDATES;
  const limit = Math.min(Math.max(requested, 1), MAX_CANDIDATES);
  if (!categoryId) {
    return jsonError(c, 400, "categoryId is required (with an optional q/brand to narrow the search)");
  }
  if (!q && !brand) {
    return jsonError(c, 400, "Provide a keyword (q) and/or brand to search");
  }

  // US-619: AI gate — enabled + within the monthly cap (whose plan = the owner's).
  const quota = await checkQuota(userId);
  if (!quota.ok) {
    return c.json(quota.body, quota.status);
  }

  // US-615: ingest candidate listings via the public Browse search.
  let candidates: ScoutCandidate[];
  try {
    const search = await searchBrowseComps({ categoryId, q, brand, limit });
    candidates = search.items
      .filter((i) => i.itemId)
      .map((i) => ({
        itemId: i.itemId,
        title: i.title,
        imageUrl: i.imageUrl,
        itemWebUrl: i.itemWebUrl,
        askingCents: i.price != null && i.price > 0 ? Math.round(i.price * 100) : null,
      }));
  } catch (err) {
    return failSafe(c, 502, "Couldn't reach eBay to search candidates. Try again shortly.", err, "scout.search");
  }

  if (candidates.length === 0) {
    return c.json({ candidates: [], scanned: 0, note: "No candidate listings matched that search." });
  }

  const scored = [];
  let graded = 0;
  for (const cand of candidates) {
    if (!cand.imageUrl) continue; // need a photo to shadow-grade

    // US-619: atomically reserve one AI action; stop cleanly when the cap is hit.
    const { data: reserved } = await supabaseAdmin.rpc("reserve_ai_action", {
      p_user_id: userId,
      p_limit: quota.limit,
    });
    if (reserved !== true) break;

    try {
      // US-616: PRIVATE shadow grade from the listing's own photo.
      const grade = await quickGrade({
        images: [{ url: cand.imageUrl, type: "front" }],
        garment: { brand: brand ?? null, title: cand.title },
      });
      // US-610: condition-adjusted value at that grade, same search identity.
      const value = await valueAtGrade({ categoryId, q, brand }, grade.overallScore);
      // US-617: score by condition-adjusted margin.
      scored.push(scoreCandidate(cand, grade.overallScore, grade.confidence, value));
      graded += 1;
    } catch (err) {
      // Refund the reserved action on failure so a transient error isn't billed.
      await supabaseAdmin.rpc("refund_ai_action", { p_user_id: userId }).then(() => {}, () => {});
      captureException(err, { level: "warn", route: "scout.grade", extra: { itemId: cand.itemId } });
    }
  }

  recordMetric("scout.scan", graded, { actionable: String(scored.filter((s) => s.actionable).length) });

  return c.json({
    scanned: graded,
    candidates: rankCandidates(scored),
    // US-620: be explicit about what this is.
    disclaimer:
      "Shadow grades are private estimates from the listing's photos — not a GradeThread certificate, and not visible to the seller. Verify condition before buying.",
  });
});
