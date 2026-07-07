// US-1698: the runnable Google Ads sync job — shared by the manual admin route
// (POST /api/admin/ads/google/sync) and the daily Coolify cron
// (POST /api/jobs/ads-sync). Kept SEPARATE from google-ads-sync.ts so that
// module's pure mappers stay unit-testable without pulling in the service-role
// client. Opens an ads_sync_runs ledger row, pulls structure + last-N-days
// metrics, upserts snapshots, and closes the run row with counts or an error.

import { supabaseAdmin } from "./supabase.ts";
import {
  googleAdsConfig,
  GoogleAdsError,
  mintGoogleAdsAccessToken,
  runGaql,
} from "./google-ads-client.ts";
import { type AdsSyncCounts, GOOGLE_ADS_PLATFORM, syncGoogleAds } from "./google-ads-sync.ts";

export interface GoogleAdsSyncOutcome {
  ok: boolean;
  configured: boolean;
  message?: string;
  counts?: AdsSyncCounts;
  window?: { since: string; until: string };
  error?: string;
  /** Suggested HTTP status for the caller to return. */
  httpStatus: number;
}

/** Inclusive [since, until] YYYY-MM-DD window for the last `days` days. */
export function lastNDays(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until.getTime() - Math.max(1, days) * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { since: fmt(since), until: fmt(until) };
}

/**
 * Run the Google Ads sync. Returns a no-op outcome (configured:false, 200) when
 * US-1697 is unconfigured — never throws for the unconfigured or Ads-error case,
 * so both the admin route and the cron get a clean, recordable result.
 */
export async function performGoogleAdsSync(
  opts: { ownerUserId?: string | null; days?: number } = {},
): Promise<GoogleAdsSyncOutcome> {
  const config = googleAdsConfig();
  if (!config) {
    return {
      ok: false,
      configured: false,
      message: "Google Ads is not configured — set the GOOGLE_ADS_* secrets to enable the sync.",
      httpStatus: 200,
    };
  }

  const ownerUserId = opts.ownerUserId ?? null;
  const days = opts.days && opts.days >= 1 && opts.days <= 365 ? Math.floor(opts.days) : 30;
  const { since, until } = lastNDays(days);

  // Open the run ledger row first so a mid-sync crash still leaves a record.
  const { data: run, error: runErr } = await supabaseAdmin
    .from("ads_sync_runs")
    .insert({ platform: GOOGLE_ADS_PLATFORM, owner_user_id: ownerUserId, status: "running" })
    .select("id")
    .single();
  if (runErr || !run) {
    return { ok: false, configured: true, error: "Couldn't start the Ads sync.", httpStatus: 500 };
  }
  const runId = (run as { id: string }).id;

  try {
    const token = await mintGoogleAdsAccessToken(config);
    const runQuery = (query: string) => runGaql(config, token, query);

    // Snapshot the account itself (name / currency / time zone).
    const acctRows = await runQuery(
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
    );
    const customer = (acctRows[0]?.customer ?? {}) as Record<string, unknown>;
    await supabaseAdmin.from("ads_accounts").upsert({
      platform: GOOGLE_ADS_PLATFORM,
      owner_user_id: ownerUserId,
      external_customer_id: config.customerId,
      descriptive_name: typeof customer.descriptiveName === "string" ? customer.descriptiveName : null,
      currency_code: typeof customer.currencyCode === "string" ? customer.currencyCode : null,
      time_zone: typeof customer.timeZone === "string" ? customer.timeZone : null,
    }, { onConflict: "platform,external_customer_id", ignoreDuplicates: false });

    const counts = await syncGoogleAds({ runQuery, supabase: supabaseAdmin, ownerUserId, since, until });

    await supabaseAdmin
      .from("ads_sync_runs")
      .update({ status: "succeeded", finished_at: new Date().toISOString(), counts })
      .eq("id", runId);

    return { ok: true, configured: true, counts, window: { since, until }, httpStatus: 200 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseAdmin
      .from("ads_sync_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error: message })
      .eq("id", runId);
    // A classified Ads error (bad token / unapproved) → 502 with the actionable
    // message; anything else → 500.
    return {
      ok: false,
      configured: true,
      error: message,
      httpStatus: err instanceof GoogleAdsError ? 502 : 500,
    };
  }
}
