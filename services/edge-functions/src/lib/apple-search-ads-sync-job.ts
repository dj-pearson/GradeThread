// US-1707: runnable Apple Search Ads sync — mints the token, pulls structure +
// daily metrics into the shared ads_* tables (platform='apple_search_ads'), and
// records an ads_sync_runs row. No-ops when ASA is unconfigured. Kept separate
// from the pure sync lib so that module stays supabase-free + unit-testable.

import { supabaseAdmin } from "./supabase.ts";
import {
  APPLE_SEARCH_ADS_PLATFORM,
  appleSearchAdsConfig,
  AppleSearchAdsError,
  mintAppleAccessToken,
} from "./apple-search-ads-client.ts";
import { type AppleSyncCounts, syncAppleSearchAds } from "./apple-search-ads-sync.ts";

export interface AppleSyncOutcome {
  ok: boolean;
  configured: boolean;
  message?: string;
  counts?: AppleSyncCounts;
  window?: { since: string; until: string };
  error?: string;
  httpStatus: number;
}

function lastNDays(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until.getTime() - Math.max(1, days) * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { since: fmt(since), until: fmt(until) };
}

export async function performAppleSearchAdsSync(
  opts: { ownerUserId?: string | null; days?: number } = {},
): Promise<AppleSyncOutcome> {
  const config = appleSearchAdsConfig();
  if (!config) {
    return {
      ok: false,
      configured: false,
      message: "Apple Search Ads is not configured — set the APPLE_SEARCH_ADS_* secrets.",
      httpStatus: 200,
    };
  }

  const ownerUserId = opts.ownerUserId ?? null;
  const days = opts.days && opts.days >= 1 && opts.days <= 365 ? Math.floor(opts.days) : 30;
  const { since, until } = lastNDays(days);

  const { data: run, error: runErr } = await supabaseAdmin
    .from("ads_sync_runs")
    .insert({ platform: APPLE_SEARCH_ADS_PLATFORM, owner_user_id: ownerUserId, status: "running" })
    .select("id")
    .single();
  if (runErr || !run) return { ok: false, configured: true, error: "Couldn't start the ASA sync.", httpStatus: 500 };
  const runId = (run as { id: string }).id;

  try {
    const token = await mintAppleAccessToken(config);
    // Snapshot the account row (currency unknown from ASA structure — leave null).
    await supabaseAdmin.from("ads_accounts").upsert({
      platform: APPLE_SEARCH_ADS_PLATFORM,
      owner_user_id: ownerUserId,
      external_customer_id: config.orgId,
      descriptive_name: "Apple Search Ads",
    }, { onConflict: "platform,external_customer_id", ignoreDuplicates: false });

    const counts = await syncAppleSearchAds({ config, token, supabase: supabaseAdmin, since, until, ownerUserId });
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
    return { ok: false, configured: true, error: message, httpStatus: err instanceof AppleSearchAdsError ? 502 : 500 };
  }
}
