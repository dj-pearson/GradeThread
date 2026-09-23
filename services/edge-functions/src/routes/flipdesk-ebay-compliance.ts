// eBay routes: account health and listing-compliance violations.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException } from "../lib/observability.ts";
import { planComplianceSync } from "../lib/ebay-compliance-plan.ts";
import { normalizeAspectMap } from "../lib/aspect-reconcile.ts";
import {
  getCustomerServiceMetric,
  getListingViolations,
  getListingViolationsSummary,
  getSellerStandardsProfile,
  isAnalyticsAccessDenied,
  isEbayConfigured,
} from "../lib/ebay-client.ts";
import { type EbayEnv } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1473: account-level eBay health — Seller Standards (current + projected)
// + the customer-service defect metrics. Read-only; a seller who hasn't granted
// Sell Analytics (or whose account lacks it) gets a graceful { access: false }
// rather than an error, mirroring the traffic-sync's analytics-access handling.
flipdeskEbayRoutes.get("/analytics/account-health", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const [current, projected, inad, inr] = await Promise.all([
      getSellerStandardsProfile(ownerId, "CURRENT"),
      getSellerStandardsProfile(ownerId, "PROJECTED"),
      getCustomerServiceMetric(ownerId, "ITEM_NOT_AS_DESCRIBED", "CURRENT"),
      getCustomerServiceMetric(ownerId, "ITEM_NOT_RECEIVED", "CURRENT"),
    ]);
    // US-1473: surface the actionable alert the AC asks for — a projected drop
    // to Below Standard means fee surcharges + search demotion.
    const projectedBelowStandard =
      projected.standardsLevel === "BELOW_STANDARD";
    return c.json({
      access: true,
      standards: { current, projected },
      customer_service: [inad, inr],
      projected_below_standard: projectedBelowStandard,
    });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) {
      // Not an error: the seller simply hasn't granted Sell Analytics. The UI
      // shows a "reconnect to see account health" affordance.
      return c.json({ access: false });
    }
    console.error("[flipdesk-ebay] /analytics/account-health failed:", err);
    return c.json({ error: "Could not load eBay account health." }, 502);
  }
});

// US-1422: Listing Health — the Sell Compliance violation summary (+ optional
// per-type detail with corrective aspect recommendations for a future one-click
// revise). Read-only; tenant-scoped; a no-access 403 returns { access:false }.
flipdeskEbayRoutes.get("/compliance/summary", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const summaries = await getListingViolationsSummary(ownerId);
    const total = summaries.reduce((n, s) => n + s.listingCount, 0);
    return c.json({ access: true, summaries, total });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/summary failed:", err);
    return c.json({ error: "Could not load eBay listing health." }, 502);
  }
});

flipdeskEbayRoutes.get("/compliance/violations", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  // ASPECTS_ADOPTION is the most common/actionable type; callers may pass others.
  const complianceType = c.req.query("type") ?? "ASPECTS_ADOPTION";
  try {
    const violations = await getListingViolations(ownerId, complianceType);
    return c.json({ access: true, complianceType, violations });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/violations failed:", err);
    return c.json({ error: "Could not load eBay listing violations." }, 502);
  }
});

// How many `platform_listing_id`s go into one clearing UPDATE. Bounded because
// the ids land in a PostgREST `in.(…)` list, which becomes a URL — an unbounded
// list is a request that fails on length rather than on anything meaningful.
const COMPLIANCE_CLEAR_CHUNK = 100;

// US-1422 chunk 2: persist per-listing compliance so the pipeline can flag
// unhealthy listings without a live API call. Matched by platform_listing_id,
// writes only to OUR DB (no eBay mutation), tenant-scoped (US-268).
//
// US-2329: it plans the whole write before making any of it, so a listing that
// is still violating is never momentarily recorded as compliant.
flipdeskEbayRoutes.post("/compliance/sync", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const summaries = await getListingViolationsSummary(ownerId);
    // Aggregate open violations per eBay listing id (across compliance types).
    const byListing = new Map<string, { count: number; types: Set<string> }>();
    for (const s of summaries) {
      if (s.listingCount <= 0) continue;
      const details = await getListingViolations(ownerId, s.complianceType);
      for (const v of details) {
        if (!v.listingId) continue;
        const e = byListing.get(v.listingId) ?? {
          count: 0,
          types: new Set<string>(),
        };
        e.count += 1;
        e.types.add(v.complianceType);
        byListing.set(v.listingId, e);
      }
    }

    const nowIso = new Date().toISOString();

    // US-2329 AC1: plan, then write. This used to zero every flagged listing in
    // one statement and re-flag row by row, so between the two — no transaction,
    // so the window is real — every listing with an open eBay policy violation
    // read as compliant.
    const { data: flaggedRows, error: readErr } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id")
      .eq("user_id", ownerId)
      .gt("compliance_violation_count", 0);
    if (readErr) {
      // Without this list the clear side cannot be a diff, and falling back to
      // "clear everything" is the defect. Fail instead.
      throw new Error(`compliance sync could not read current flags: ${readErr.message}`);
    }
    const plan = planComplianceSync(
      ((flaggedRows ?? []) as Array<{ platform_listing_id: string | null }>).map(
        (r) => r.platform_listing_id,
      ),
      byListing,
    );

    // AC2: an update that fails is a listing whose health is now WRONG in our
    // DB. It used to be counted away — `if (!upErr) flagged += 1` — which
    // reported a smaller success number and no error at all.
    const errors: string[] = [];
    let flagged = 0;
    let cleared = 0;

    // Violators first. A listing that is violating now and was violating before
    // is rewritten in place and never passes through zero.
    for (const t of plan.toFlag) {
      const { error: upErr } = await supabaseAdmin
        .from("listings")
        .update({
          compliance_violation_count: t.count,
          compliance_types: t.types,
          compliance_checked_at: nowIso,
        } as never)
        .eq("user_id", ownerId)
        .eq("platform_listing_id", t.platformListingId);
      if (upErr) errors.push(`flag ${t.platformListingId}: ${upErr.message}`);
      else flagged += 1;
    }

    // Then, and only then, the listings that have genuinely become clean.
    for (let i = 0; i < plan.toClear.length; i += COMPLIANCE_CLEAR_CHUNK) {
      const chunk = plan.toClear.slice(i, i + COMPLIANCE_CLEAR_CHUNK);
      const { error: clearErr } = await supabaseAdmin
        .from("listings")
        .update({
          compliance_violation_count: 0,
          compliance_types: null,
          compliance_checked_at: nowIso,
        } as never)
        .eq("user_id", ownerId)
        .in("platform_listing_id", chunk);
      if (clearErr) errors.push(`clear ${chunk.length} listing(s): ${clearErr.message}`);
      else cleared += chunk.length;
    }

    if (errors.length > 0) {
      // AC2 + AC3: the failure reaches the seller who asked for it, and an
      // operator, in the same breath. `ok:false` is the machine-readable half —
      // a caller that only reads `flagged` would otherwise see a plausible
      // number for a sync that left listings mislabelled.
      console.error("[flipdesk-ebay] /compliance/sync partial failure:", errors);
      captureException(
        new Error(`compliance sync wrote ${errors.length} bad update(s)`),
        { route: "flipdesk.ebay.compliance-sync", userId: ownerId },
      );
      return c.json(
        {
          ok: false,
          access: true,
          flagged,
          cleared,
          failed: errors.length,
          errors: errors.slice(0, 20),
          error: "Some listings could not be updated. Listing health may be out of date.",
        },
        502,
      );
    }

    return c.json({ ok: true, access: true, flagged, cleared });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/sync failed:", err);
    return c.json({ error: "Could not sync eBay listing health." }, 502);
  }
});

// US-1422 chunk 3 (AC3): apply eBay's corrective aspect recommendations for a
// listing's ASPECTS_ADOPTION violations into its item_specifics_override
// (ADD-ONLY — never overwrite an existing aspect or fabricate a value). This
// writes only to OUR DB; the client then calls the EXISTING revise endpoint with
// resync_ebay_fields:true to push the merged specifics to the live eBay offer,
// so the risky eBay mutation reuses the proven path rather than new code.
flipdeskEbayRoutes.post("/compliance/apply-recommendations/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const listingId = c.req.param("id");
  try {
    // Ownership-scoped load (US-268).
    const { data: listingRow, error: loadErr } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id, item_specifics_override")
      .eq("id", listingId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    const row = listingRow as
      | {
          id: string;
          platform_listing_id: string | null;
          item_specifics_override: Record<string, string[]> | null;
        }
      | null;
    if (!row) return c.json({ error: "Listing not found." }, 404);
    if (!row.platform_listing_id) {
      return c.json({ error: "Listing isn't published to eBay yet." }, 409);
    }

    const violations = await getListingViolations(ownerId, "ASPECTS_ADOPTION");
    const match = violations.find(
      (v) => v.listingId === row.platform_listing_id,
    );
    const recs = match?.aspectRecommendations ?? [];

    // US-1505: coerce any legacy string-valued row to string[] so the merged
    // map we re-persist (and later re-PUT to eBay) is uniformly typed.
    const aspects: Record<string, string[]> = normalizeAspectMap(
      row.item_specifics_override as Record<string, unknown> | null,
    );
    const added: string[] = [];
    for (const rec of recs) {
      const name = rec.name.trim();
      const values = rec.values.map((v) => v.trim()).filter((v) => v.length > 0);
      // Add-only: never overwrite a value the seller already set, never invent
      // a name with no recommended values.
      if (!name || values.length === 0) continue;
      if (aspects[name] && aspects[name].length > 0) continue;
      aspects[name] = values;
      added.push(name);
    }

    if (added.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("listings")
        .update({ item_specifics_override: aspects } as never)
        .eq("id", row.id)
        .eq("user_id", ownerId);
      if (upErr) throw upErr;
    }

    // The client pushes to eBay via POST /listings/:id/revise { resync_ebay_fields }.
    return c.json({ applied: added.length, aspects: added });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/apply-recommendations failed:", err);
    return c.json({ error: "Could not apply eBay recommendations." }, 502);
  }
});
