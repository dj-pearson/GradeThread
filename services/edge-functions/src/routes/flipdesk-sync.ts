// US-2697: sold-sync observation intake.
//
// The browser extension reads the seller's own Sold page and closet and posts
// what it saw. This route decides what any of it MEANS, because a selector
// regression must produce a bad observation rather than a bad delist, and
// because this ships with an edge deploy while extension logic waits days for
// store review.
//
// The deciding itself is pure and lives in lib/marketplace-observations.ts.
// Everything here is the impure half: load the tenant's listings, load what we
// have already seen, persist the plan, and hand a confirmed sale to the
// existing cross-listing delist planner that has never had a trigger on these
// channels.
//
// TENANCY (US-268). The service-role client bypasses RLS. `listings` is scoped
// through inventory_items.user_id (ownership-via-parent, the convention the
// whole delist path uses), and every sync table is filtered on user_id
// directly. A listing id supplied by the extension is attacker-controlled
// input and is never used unfiltered.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { resolveSellerEntitlement } from "../lib/buyer-entitlements.ts";
import { autoEndCrossListings } from "../lib/cross-listings.ts";
import { EXTENSION_DELIST_PLATFORMS } from "../lib/cross-listing-sale.ts";
import { findForbiddenKey } from "../lib/sync-payload-guard.ts";
import {
  planObservations,
  type ClosetObservation,
  type KnownListing,
  type ObservationBatch,
  type SoldObservation,
} from "../lib/marketplace-observations.ts";

export const flipdeskSyncRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

/** Bounds one batch. A closet page is ~48 cards; this is several pages' worth. */
const MAX_SOLD_ROWS = 200;
const MAX_CLOSET_URLS = 2000;

interface ListingRow {
  id: string;
  inventory_item_id: string;
  platform: string;
  listing_url: string | null;
  listing_title: string | null;
  listing_price: number | null;
  listing_status: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Read the batch off the wire.
 *
 * Everything is coerced rather than trusted, and anything unrecognised is
 * dropped instead of passed through: the planner's rules are only as good as
 * the shape it is handed, and `reachedEnd` in particular decides whether an
 * absence counts as evidence at all. A missing or non-boolean `reachedEnd`
 * therefore reads as FALSE, so a malformed batch under-claims coverage rather
 * than inventing it.
 */
function parseBatch(body: Record<string, unknown>): ObservationBatch | null {
  const platform = str(body.platform)?.toLowerCase() ?? null;
  if (!platform || !EXTENSION_DELIST_PLATFORMS.has(platform)) return null;

  const rawSold = Array.isArray(body.sold) ? body.sold.slice(0, MAX_SOLD_ROWS) : [];
  const sold: SoldObservation[] = [];
  for (const entry of rawSold) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    sold.push({
      listingUrl: str(e.listingUrl),
      title: str(e.title),
      soldPriceCents: int(e.soldPriceCents),
      soldAt: str(e.soldAt),
      orderRef: str(e.orderRef),
      thumbAssetId: str(e.thumbAssetId),
    });
  }

  let closet: ClosetObservation | null = null;
  const rawCloset = body.closet;
  if (rawCloset && typeof rawCloset === "object" && !Array.isArray(rawCloset)) {
    const cl = rawCloset as Record<string, unknown>;
    const urls = Array.isArray(cl.listingUrls)
      ? cl.listingUrls.slice(0, MAX_CLOSET_URLS).map(str).filter((u): u is string => u !== null)
      : [];
    closet = {
      listingUrls: urls,
      pagesRead: int(cl.pagesRead) ?? 0,
      reachedEnd: cl.reachedEnd === true,
    };
  }

  return {
    platform,
    observedAt: str(body.observedAt) ?? new Date().toISOString(),
    signedIn: body.signedIn !== false,
    sold,
    closet,
  };
}

/** Is this account allowed to sync at all? Same resolution as the Lister gate. */
async function sellerGate(ownerId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerId)
    .maybeSingle();
  const row = data as {
    flipdesk_plan: string | null;
    subscription_status: string | null;
    trial_ends_at: string | null;
    past_due_since: string | null;
  } | null;
  return resolveSellerEntitlement({
    flipdeskPlan: row?.flipdesk_plan ?? null,
    flipdeskStatus: row?.subscription_status ?? null,
    trialEndsAt: row?.trial_ends_at ?? null,
    pastDueSince: row?.past_due_since ?? null,
  }).sellerEnabled;
}

flipdeskSyncRoutes.post("/observations", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json({ error: "Expected a JSON observation batch." }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  // Refuse credentials and buyer identity BEFORE anything else touches the
  // payload — including before the seller gate, so a rejected key is never
  // logged or persisted on any path.
  const forbidden = findForbiddenKey(body);
  if (forbidden) {
    return c.json(
      {
        error: "FORBIDDEN_KEY",
        key: forbidden,
        message:
          "A sync observation may not carry credentials or buyer identity. " +
          "GradeThread never receives your marketplace session, and never the " +
          "name or address of someone who bought from you.",
      },
      400,
    );
  }

  if (!(await sellerGate(ownerId))) {
    return c.json(
      { error: "FEATURE_LOCKED", feature: "sync", message: "Sold-sync is a FlipDesk seller feature." },
      402,
    );
  }

  const batch = parseBatch(body);
  if (!batch) {
    return c.json({ error: "Unsupported or missing marketplace for sold-sync." }, 400);
  }

  try {
    // Tenant-scoped via the parent item (US-268). `listings` carries a
    // denormalized user_id since 00146, but the entire delist path scopes
    // through inventory_items and mixing the two is how a scope check lands on
    // the wrong column.
    const { data: rawListings, error: listErr } = await supabaseAdmin
      .from("listings")
      .select(
        "id, inventory_item_id, platform, listing_url, listing_title, listing_price, listing_status, inventory_items!inner(user_id)",
      )
      .eq("platform", batch.platform)
      .eq("inventory_items.user_id", ownerId);
    if (listErr) throw new Error(listErr.message);

    const known: KnownListing[] = ((rawListings ?? []) as unknown as ListingRow[]).map((l) => ({
      id: l.id,
      itemId: l.inventory_item_id,
      platform: l.platform,
      listingUrl: l.listing_url,
      title: l.listing_title,
      // listings.listing_price is a decimal in MAJOR units (00002). The
      // planner compares cents, so convert here rather than teaching the
      // pure module about one table's units.
      priceCents: l.listing_price == null ? null : Math.round(l.listing_price * 100),
      listingStatus: l.listing_status,
    }));

    const { data: seenRows } = await supabaseAdmin
      .from("marketplace_sync_observations")
      .select("dedupe_key")
      .eq("user_id", ownerId)
      .eq("platform", batch.platform);
    const seenKeys = new Set(
      ((seenRows ?? []) as { dedupe_key: string }[]).map((r) => r.dedupe_key),
    );

    const plan = planObservations({ batch, known, seenKeys });

    // Channel state is recorded on EVERY read, including the failing ones —
    // that record is the whole point of the failing status, and a read that
    // wrote nothing at all would look exactly like a read that never happened.
    await supabaseAdmin
      .from("marketplace_sync_state")
      .upsert({
        user_id: ownerId,
        platform: batch.platform,
        status: plan.channelStatus,
        failure_reason: plan.failureReason,
        listings_seen: batch.closet?.listingUrls.length ?? null,
        last_read_at: batch.observedAt,
        ...(plan.channelStatus === "ok" ? { last_ok_at: batch.observedAt } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,platform" });

    if (plan.channelStatus !== "ok") {
      return c.json({
        status: plan.channelStatus,
        reason: plan.failureReason,
        confirmed: 0,
        review: 0,
        unmatched: 0,
      });
    }

    // ── review rows ────────────────────────────────────────────────────────
    // Upserted on the partial unique index so a poll every 30 minutes reporting
    // the same unexplained absence does not hand the seller forty copies of one
    // problem.
    if (plan.review.length > 0) {
      const rows = plan.review.map((r) => ({
        user_id: ownerId,
        platform: batch.platform,
        reason: r.reason,
        status: "open",
        listing_id: r.listingId,
        inventory_item_id: r.itemId,
        listing_url: r.listingUrl,
        title: r.title,
        sold_price_cents: r.soldPriceCents,
        sold_at: r.soldAt,
        dedupe_key: r.dedupeKey,
        unexplained: r.unexplained ?? null,
        claimed: r.claimed ?? null,
        cap: r.limit ?? null,
        updated_at: new Date().toISOString(),
      }));
      const withListing = rows.filter((r) => r.listing_id !== null);
      const withoutListing = rows.filter((r) => r.listing_id === null);
      if (withListing.length > 0) {
        await supabaseAdmin.from("marketplace_sync_reviews").upsert(withListing, {
          onConflict: "user_id,platform,reason,listing_id",
          ignoreDuplicates: false,
        });
      }
      // count_gap and circuit_breaker carry no listing id, so the partial index
      // does not cover them; they are plain inserts and are expected to recur.
      if (withoutListing.length > 0) {
        await supabaseAdmin.from("marketplace_sync_reviews").insert(withoutListing);
      }
    }

    // ── unmatched sales ────────────────────────────────────────────────────
    if (plan.unmatched.length > 0) {
      await supabaseAdmin.from("marketplace_sync_reviews").insert(
        plan.unmatched.map((u) => ({
          user_id: ownerId,
          platform: batch.platform,
          reason: "probable_match",
          status: "open",
          listing_id: null,
          inventory_item_id: null,
          listing_url: u.listingUrl,
          title: u.title,
          sold_price_cents: u.soldPriceCents,
          sold_at: u.soldAt,
          dedupe_key: u.dedupeKey,
        })),
      );
    }

    // ── confirmed sales ────────────────────────────────────────────────────
    let delisted = 0;
    for (const sale of plan.confirmed) {
      // The dedupe ledger goes in FIRST and its unique index is the real guard:
      // two polls racing on the same Sold page would otherwise both pass the
      // seenKeys read above and book the sale twice.
      const { error: dupErr } = await supabaseAdmin
        .from("marketplace_sync_observations")
        .insert({
          user_id: ownerId,
          platform: batch.platform,
          dedupe_key: sale.dedupeKey,
          listing_id: sale.listingId,
          sold_at: sale.soldAt,
          observed_at: batch.observedAt,
        });
      if (dupErr) continue; // unique violation: another poll already booked it

      await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold", sold_at: sale.soldAt })
        .eq("id", sale.listingId)
        .eq("inventory_item_id", sale.itemId);

      await supabaseAdmin.from("sales").insert({
        inventory_item_id: sale.itemId,
        listing_id: sale.listingId,
        platform_order_id: sale.dedupeKey,
        line_item_id: "",
        quantity: 1,
        sale_price: sale.soldPriceCents == null ? null : sale.soldPriceCents / 100,
        sale_date: sale.soldAt?.slice(0, 10) ?? null,
        sold_at: sale.soldAt,
        // Deliberately null: the observer never reads buyer identity, and there
        // is no column on the sync tables that could have carried it here.
        buyer_username: null,
        buyer_id: null,
        status: "completed",
      });

      // The handoff this whole story exists for. Best-effort by construction:
      // autoEndCrossListings never throws, and a sale must not fail because a
      // sibling delist did.
      const summary = await autoEndCrossListings(ownerId, sale.listingId);
      delisted += summary.ended + summary.queued;
    }

    return c.json({
      status: "ok",
      confirmed: plan.confirmed.length,
      review: plan.review.length,
      unmatched: plan.unmatched.length,
      breakerTripped: plan.breakerTripped,
      siblingsHandled: delisted,
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't record the sync observations.", err, "flipdesk.sync.observations");
  }
});
