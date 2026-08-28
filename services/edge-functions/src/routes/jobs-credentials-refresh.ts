// US-2272: keep the verified-seller credential block current on LIVE eBay
// listings of GRADED items.
//
// The block (US-1126, lib/seller-credentials.ts) is rendered once at draft time
// and then frozen into the published description, so a seller's earlier
// listings keep advertising the count they had that week — observed in the wild
// as "13 items independently graded" on one listing and "19 items" on the next.
//
// eBay bans active content in descriptions (no script, no iframe, no remote
// include), so a self-updating embed is not an option; and an off-eBay link is
// its own policy hit (see buildSellerCredentialBlock). The only compliant fix is
// to REVISE the description, which eBay permits at any time, for free, on an
// active listing — even one with sales or bids.
//
// Scope, deliberately narrow:
//   • GRADED items only — the operator asked for the graded surface, and a
//     graded listing is the one whose buyer is reading the block for the grade.
//   • Live GradeThread-origin eBay listings only (a real platform_offer_id;
//     eBay-imported mirrors are read-only, same rule as resyncGradeToLiveListing).
//   • Sellers who are publicly verified AND opted into the listing embed — the
//     same three-way gate loadSellerCredentialBlock applies at draft time.
//   • Only listings that ALREADY carry a block. A refresh never injects one:
//     that would push marketing copy into a description the seller wrote.
//
// Cost control, because the average grade moves with every new grade and would
// otherwise dirty every listing at once:
//   • The DB copy is compared FIRST, so a steady-state run makes ZERO eBay calls.
//   • Revisions per run are capped (system_settings, default MAX_REVISIONS).
//   • Candidates are taken least-recently-updated first, so a seller with more
//     dirty listings than the cap cycles through them over successive runs
//     instead of the same head of the list winning every time.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { logEvent } from "../lib/observability.ts";
import { getSetting } from "../lib/system-settings.ts";
import { getOffer, isEbayConfigured, updateOfferFields } from "../lib/ebay-client.ts";
import { loadSellerCredentialBlock } from "../lib/seller-credentials-job.ts";
import {
  refreshSellerCredentialBlock,
  SELLER_CREDENTIALS_MARKER,
} from "../lib/seller-credentials.ts";
import {
  renderAndPersistDescription,
  renderListingDescription,
} from "../lib/description-render.ts";
import type { DescriptionBlock } from "../lib/description-blocks.ts";

/** Lease: one GET + one PUT per dirty listing, bounded by MAX_REVISIONS. */
const LEASE_SECONDS = 600;
/** Eligible sellers examined per run. */
const MAX_SELLERS = 200;
/** Candidate listings pulled per seller per run. */
const LISTINGS_PER_SELLER = 500;
/** Default eBay revisions per run (override: credentials_refresh.max_per_run). */
const MAX_REVISIONS = 100;
/**
 * Consecutive eBay failures that abandon a seller for this run. A dead/revoked
 * token fails identically on all of their listings, so retrying 300 times only
 * burns the run's budget and the rate limit.
 */
const SELLER_ERROR_LIMIT = 3;

const LISTING_COLUMNS = "id, inventory_item_id, platform_offer_id, listing_description, " +
  "description_blocks, listing_origin, marketplace_connection_id, " +
  "inventory_items!inner(user_id, grade_value, description)";

interface CandidateRow {
  id: string;
  inventory_item_id: string;
  platform_offer_id: string | null;
  listing_description: string | null;
  /** US-2963: non-null means this listing is block-backed and re-renders. */
  description_blocks: DescriptionBlock[] | null;
  listing_origin: string | null;
  marketplace_connection_id: string | null;
  inventory_items: {
    user_id: string;
    grade_value: number | null;
    description: string | null;
  };
}

export interface CredentialsRefreshResult {
  sellers_eligible: number;
  listings_scanned: number;
  /** Live eBay descriptions revised. */
  revised: number;
  /** Block already matched the fresh render — no eBay call made. */
  up_to_date: number;
  /** No block in the description; left alone (never injected). */
  no_block: number;
  /** DB copy refreshed without an eBay write (live copy had no block). */
  db_only: number;
  /** US-2963: refreshed by re-rendering blocks rather than walking div depth. */
  rendered: number;
  errors: number;
  /** True when the run hit the revision cap — the rest wait for the next run. */
  capped: boolean;
}

/**
 * Refresh the credential block on the ITEM's own draft description.
 *
 * `inventory_items.description` is a plain string — it has no blocks and never
 * will — and it is the fallback source resyncGradeToLiveListing reads, so a
 * stale block here resurfaces through that path however carefully the listing
 * was re-rendered. The div walk is the only tool that fits a column with no
 * blocks behind it, and US-2963's rule is about the LISTING write path.
 *
 * DB only, no eBay call.
 */
async function refreshItemDescription(
  row: CandidateRow,
  sellerId: string,
  html: string,
): Promise<void> {
  const itemDesc = row.inventory_items.description;
  if (!itemDesc) return;
  const itemNext = refreshSellerCredentialBlock(itemDesc, html);
  if (itemNext === null || itemNext === itemDesc) return;
  await supabaseAdmin
    .from("inventory_items")
    .update({ description: itemNext })
    .eq("id", row.inventory_item_id)
    .eq("user_id", sellerId);
}

/**
 * Refresh one seller's graded live listings. Exported for the route only; the
 * eBay I/O makes this integration-shaped, so the unit tests cover the pure
 * block swap (lib/seller-credentials.ts) and this function's guards are the
 * same ones resyncGradeToLiveListing already proves in production.
 *
 * Tenant isolation (US-268): every read and write here is scoped to `sellerId`,
 * and the eBay calls go through that seller's own connection. A cron has no JWT,
 * so the tenant is resolved from the row being processed — never from input.
 */
async function refreshSeller(
  sellerId: string,
  html: string,
  budget: number,
  result: CredentialsRefreshResult,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(LISTING_COLUMNS)
    .eq("user_id", sellerId)
    .eq("platform", "ebay")
    .not("platform_offer_id", "is", null)
    .in("listing_status", ["active", "relisted"])
    .not("inventory_items.grade_value", "is", null)
    // Least-recently-touched first: a write below bumps updated_at, so the cap
    // rotates through a large backlog instead of re-picking the same head.
    .order("updated_at", { ascending: true })
    .limit(LISTINGS_PER_SELLER);
  if (error) {
    logEvent("warn", "credentials_refresh.listing_query_failed", {
      seller: sellerId,
      error: error.message,
    });
    result.errors++;
    return budget;
  }

  const rows = (data ?? []) as unknown as CandidateRow[];
  let sellerErrors = 0;

  for (const row of rows) {
    if (budget <= 0) return 0;
    const offerId = row.platform_offer_id;
    if (!offerId) continue;
    // eBay-imported mirrors are read-only. `listing_origin` is NULL on rows
    // predating the column, so filter in JS — a `.neq()` would drop those NULLs.
    if (row.listing_origin === "ebay") continue;
    result.listings_scanned++;

    const dbDesc = row.listing_description ?? "";
    const connId = row.marketplace_connection_id ?? undefined;
    const blocks = row.description_blocks;

    // ── US-2963: the block-backed path ──────────────────────────────
    //
    // A listing that carries `description_blocks` has a description that is
    // DERIVED, so refreshing the badge is a re-render rather than surgery on
    // markup. That matters because the surgery could fail: the div walk in
    // findSellerCredentialBlock gives up on an unclosed element or after
    // MAX_TAG_SCAN tags, and its only safe answer is null — which this loop
    // counts as "no block" and skips forever. A malformed description used to
    // defeat the refresh permanently and silently. It cannot now.
    if (blocks?.length) {
      // Freshness, decided by a substring rather than a render. The renderer
      // emits the credential html verbatim after its marker, so a description
      // already containing `html` is already current — and a steady-state run
      // therefore still costs zero extra queries per listing, which is what
      // keeps this cron affordable over 200 sellers.
      if (!dbDesc.includes(SELLER_CREDENTIALS_MARKER)) {
        // Same rule as the legacy path: a refresh NEVER injects a block into a
        // description that never carried one.
        result.no_block++;
        continue;
      }
      if (dbDesc.includes(html)) {
        result.up_to_date++;
        continue;
      }

      const fresh = await renderListingDescription(
        row.id,
        sellerId,
        blocks,
      );
      if (!fresh) {
        result.errors++;
        continue;
      }
      // A render that would REMOVE the block is refused outright. It means the
      // two credential loaders disagree about this seller, or the credentials
      // block was switched off while the stored string still shows one — either
      // way, silently stripping a buyer-facing trust badge is not a refresh.
      if (!fresh.description.includes(html)) {
        logEvent("warn", "credentials_refresh.render_would_drop_block", {
          seller: sellerId,
          listing: row.id,
        });
        result.errors++;
        continue;
      }

      try {
        const offer = await getOffer(sellerId, offerId, connId);
        const liveDesc = typeof offer.listingDescription === "string"
          ? offer.listingDescription
          : "";
        if (liveDesc !== fresh.description) {
          await updateOfferFields(
            sellerId,
            offerId,
            { listingDescription: fresh.description },
            connId,
          );
          result.revised++;
          budget--;
        } else {
          result.db_only++;
        }
        sellerErrors = 0;
      } catch (err) {
        logEvent("warn", "credentials_refresh.ebay_push_failed", {
          seller: sellerId,
          listing: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        result.errors++;
        if (++sellerErrors >= SELLER_ERROR_LIMIT) {
          logEvent("warn", "credentials_refresh.seller_abandoned", {
            seller: sellerId,
            consecutive_errors: sellerErrors,
          });
          return budget;
        }
        continue;
      }

      // Both columns, one update, from the same blocks that produced what was
      // just pushed — so the composer, the next revise and the next run all
      // agree, and `listing_description` never claims a shape
      // `description_blocks` did not produce.
      const saved = await renderAndPersistDescription(
        row.id,
        sellerId,
        fresh.blocks,
      );
      if (!saved) result.errors++;
      else result.rendered++;
      await refreshItemDescription(row, sellerId, html);
      continue;
    }

    // ── The legacy path, for listings not yet converted ─────────────
    const dbNext = refreshSellerCredentialBlock(dbDesc, html);
    if (dbNext === null) {
      result.no_block++;
      continue;
    }
    if (dbNext === dbDesc) {
      result.up_to_date++;
      continue;
    }

    // The live offer is the truth about what buyers see, and the DB copy can
    // have drifted (an eBay-side edit, a failed earlier revise). Swap the block
    // inside the LIVE description so a revise changes the block and nothing else.
    let liveNext: string | null = null;
    try {
      const offer = await getOffer(sellerId, offerId, connId);
      const liveDesc = typeof offer.listingDescription === "string"
        ? offer.listingDescription
        : "";
      liveNext = refreshSellerCredentialBlock(liveDesc, html);
      if (liveNext !== null && liveNext !== liveDesc) {
        await updateOfferFields(
          sellerId,
          offerId,
          { listingDescription: liveNext },
          connId,
        );
        result.revised++;
        budget--;
      } else {
        // Live copy has no block (or is already fresh) — nothing to push, but
        // the DB copy still needs correcting so the next revise carries it.
        result.db_only++;
      }
      sellerErrors = 0;
    } catch (err) {
      logEvent("warn", "credentials_refresh.ebay_push_failed", {
        seller: sellerId,
        listing: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
      if (++sellerErrors >= SELLER_ERROR_LIMIT) {
        logEvent("warn", "credentials_refresh.seller_abandoned", {
          seller: sellerId,
          consecutive_errors: sellerErrors,
        });
        return budget;
      }
      continue;
    }

    // Persist the copy we just pushed (falling back to the DB-derived swap when
    // the live description carried no block) so the composer, the next revise
    // and the next run all agree.
    await supabaseAdmin
      .from("listings")
      .update({ listing_description: liveNext ?? dbNext })
      .eq("id", row.id)
      .eq("user_id", sellerId);

    await refreshItemDescription(row, sellerId, html);
  }

  return budget;
}

/**
 * Cron: POST /api/jobs/credentials-refresh (job-secret gated, overlap-locked).
 * Idempotent by construction — a second run finds every block already fresh and
 * makes no eBay calls.
 */
export async function handleCredentialsRefreshCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  // Kill-switch + budget without a migration: an absent system_settings row
  // serves the code default, so ops can tune or stop this from /admin/ops/settings
  // by inserting the key, and the job behaves sanely until they do.
  if (!(await getSetting<boolean>("credentials_refresh.enabled", true))) {
    return c.json({ ok: true, skipped: true, reason: "disabled" });
  }
  const maxRevisions = Math.max(
    0,
    await getSetting<number>("credentials_refresh.max_per_run", MAX_REVISIONS),
  );

  const lock = await acquireJobLock("credentials-refresh", LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result: CredentialsRefreshResult = {
      sellers_eligible: 0,
      listings_scanned: 0,
      revised: 0,
      up_to_date: 0,
      no_block: 0,
      db_only: 0,
      rendered: 0,
      errors: 0,
      capped: false,
    };

    const { data: sellerData, error: sellerError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("verified_enabled", true)
      .eq("verified_embed_in_listings", true)
      .not("verified_handle", "is", null)
      .limit(MAX_SELLERS);
    if (sellerError) {
      logEvent("warn", "credentials_refresh.seller_query_failed", {
        error: sellerError.message,
      });
      return c.json({ ok: false, error: "seller_query_failed" }, 500);
    }
    const sellers = (sellerData ?? []) as Array<{ id: string }>;

    let budget = maxRevisions;
    for (const seller of sellers) {
      if (budget <= 0) {
        result.capped = true;
        break;
      }
      // Re-derives eligibility + the current stats per seller; returns null if
      // they un-verified or opted out since the query above.
      const block = await loadSellerCredentialBlock(seller.id);
      if (!block) continue;
      result.sellers_eligible++;
      budget = await refreshSeller(seller.id, block.html, budget, result);
    }
    if (budget <= 0) result.capped = true;

    // Never let a cap read as "everything is current" (the silent-truncation
    // failure mode): say so in the log as well as the response.
    if (result.capped) {
      logEvent("info", "credentials_refresh.capped", {
        max_per_run: maxRevisions,
        revised: result.revised,
      });
    }

    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
}
