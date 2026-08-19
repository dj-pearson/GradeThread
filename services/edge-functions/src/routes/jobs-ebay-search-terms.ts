// US-2683: pull each seller's eBay Promoted Listings search-term report.
//
// Runs daily. The reports cover a 30-day window and eBay regenerates them on
// its own clock, so a tighter cadence would re-download the same numbers and
// spend rate budget doing it.
//
// MOST TICKS DO ALMOST NOTHING, by design. The report only exists for a seller
// running a Priority (CPC) campaign, and most are not — so the common outcome
// is no_campaign, counted and not logged. A cron that shouted about that would
// be a cron nobody reads.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  AD_REPORT_TYPES,
  hasAdReportTransport,
  type PullOutcome,
  pullSearchTerms,
  summarizePulls,
} from "../lib/ebay-ad-reports.ts";

/** Sellers touched per tick. Bounded so one run cannot become an hour. */
const OWNERS_PER_RUN = 50;

export async function handleEbaySearchTermsCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!hasAdReportTransport()) {
    // The Marketing module registers it at import. Missing means a wiring
    // regression, which is worth saying rather than reporting a clean zero.
    return c.json({ ok: false, error: "ad report transport not registered" }, 503);
  }

  const lock = await acquireJobLock("ebay-search-terms", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      .not("ebay_cpc_campaign_id", "is", null)
      .limit(OWNERS_PER_RUN);
    if (error) {
      console.error("[ebay-search-terms] connection scan failed:", error.message);
      return c.json({ ok: false, error: "scan failed" }, 500);
    }

    const owners = [
      ...new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    ];

    const outcomes: PullOutcome[] = [];
    for (const ownerId of owners) {
      for (const reportType of AD_REPORT_TYPES) {
        // Sequential on purpose. These are per-seller eBay calls against a
        // shared rate budget, and a fan-out here is how one tick starves the
        // publish path that shares it.
        outcomes.push(await pullSearchTerms(ownerId, reportType));
      }
    }

    return c.json({ ok: true, owners: owners.length, ...summarizePulls(outcomes) });
  } finally {
    await lock.release();
  }
}
