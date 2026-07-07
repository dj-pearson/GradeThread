// US-1704: offline conversion import.
//
// Reads ad_click_attributions rows whose user hit a conversion event (US-1700)
// and uploads them to Google Ads via ConversionUploadService (gclid → conversion
// action + value + time), so Smart Bidding optimizes toward customers who
// actually convert + pay. Idempotent (each converted row uploads once — uploaded_at
// gates re-selection; Google also dedupes by gclid+action+time), records
// success/skip/failure per row (no silent drops), and no-ops when Ads is
// unconfigured. gclid only — gbraid/wbraid need the enhanced-conversions flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ClickConversion,
  googleAdsConfig,
  mintGoogleAdsAccessToken,
  uploadClickConversions,
} from "./google-ads-client.ts";
import { type ConversionDefinition, getConversionDefinitions } from "./ads-conversions.ts";

export const GOOGLE_ADS_PLATFORM = "google_ads";
const MAX_BATCH = 2000;
// Google's click-conversion window: a click older than this is rejected.
const GCLID_MAX_AGE_DAYS = 90;

/** Format an ISO timestamp as Google's "yyyy-MM-dd HH:mm:ss+00:00" (UTC). */
export function formatConversionDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}

export interface AttributionRow {
  id: string;
  click_id: string;
  click_id_type: string;
  converted_at: string | null;
  conversion_type: string | null;
  value: number | null;
  landing_at: string | null;
}

export type UploadRowResult =
  | { conversion: ClickConversion }
  | { skip: string };

/**
 * Build a ConversionUploadService row from an attribution + its conversion
 * definition, or a skip reason (non-gclid, no configured action, no conversion,
 * or an expired gclid) — never a silent drop.
 */
export function buildUploadRow(
  attr: AttributionRow,
  definition: ConversionDefinition | null,
  currencyCode: string,
  now: Date = new Date(),
): UploadRowResult {
  if (attr.click_id_type !== "gclid") {
    return { skip: `non-gclid click id (${attr.click_id_type}) — enhanced conversions not supported` };
  }
  if (!attr.converted_at) return { skip: "no conversion recorded" };
  if (!definition) return { skip: `no conversion definition for "${attr.conversion_type}"` };
  if (!definition.conversionAction) {
    return { skip: `no conversion action configured for "${definition.event}"` };
  }
  // Expiry: measured from the click (landing), not the conversion.
  const clickAt = attr.landing_at ? new Date(attr.landing_at) : new Date(attr.converted_at);
  const ageDays = (now.getTime() - clickAt.getTime()) / 86_400_000;
  if (ageDays > GCLID_MAX_AGE_DAYS) {
    return { skip: `gclid expired (${Math.floor(ageDays)}d > ${GCLID_MAX_AGE_DAYS}d)` };
  }
  return {
    conversion: {
      gclid: attr.click_id,
      conversionAction: definition.conversionAction,
      conversionDateTime: formatConversionDateTime(attr.converted_at),
      conversionValue: attr.value ?? definition.value,
      currencyCode: currencyCode || "USD",
    },
  };
}

/** Split a batch of attribution rows into uploadable conversions + skip reasons. */
export function buildUploadBatch(
  rows: AttributionRow[],
  definitions: ConversionDefinition[],
  currency: string,
  now: Date = new Date(),
): { toUpload: Array<{ row: AttributionRow; conversion: ClickConversion }>; skips: Array<{ id: string; reason: string }> } {
  const byEvent = new Map(definitions.map((d) => [d.event.toLowerCase(), d] as const));
  const toUpload: Array<{ row: AttributionRow; conversion: ClickConversion }> = [];
  const skips: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    const def = row.conversion_type ? byEvent.get(row.conversion_type.toLowerCase()) ?? null : null;
    const built = buildUploadRow(row, def, currency, now);
    if ("skip" in built) skips.push({ id: row.id, reason: built.skip });
    else toUpload.push({ row, conversion: built.conversion });
  }
  return { toUpload, skips };
}

export interface UploadResult {
  configured: boolean;
  uploaded: number;
  skipped: number;
  failed: number;
  message?: string;
}

/** Best-effort: operation indices Google flagged in a partialFailureError. */
export function failedIndicesFromPartialError(err: unknown): Set<number> {
  const out = new Set<number>();
  const details = (err as { details?: unknown[] } | null)?.details;
  if (!Array.isArray(details)) return out;
  for (const d of details) {
    const errors = (d as { errors?: unknown[] })?.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      const els = (e as { location?: { fieldPathElements?: Array<{ fieldName?: string; index?: number }> } })
        ?.location?.fieldPathElements;
      if (!Array.isArray(els)) continue;
      for (const el of els) {
        if ((el.fieldName === "conversions" || el.fieldName === "operations") && typeof el.index === "number") {
          out.add(el.index);
        }
      }
    }
  }
  return out;
}

/** Read converted-but-unuploaded attributions, upload them, and record per-row status. */
export async function uploadOfflineConversions(
  deps: { supabase: SupabaseClient; ownerUserId?: string | null },
): Promise<UploadResult> {
  const config = googleAdsConfig();
  if (!config) return { configured: false, uploaded: 0, skipped: 0, failed: 0, message: "Google Ads not configured." };

  const supabase = deps.supabase;
  const [{ data: attrs }, { data: account }] = await Promise.all([
    supabase
      .from("ad_click_attributions")
      .select("id, click_id, click_id_type, converted_at, conversion_type, value, landing_at")
      .eq("platform", GOOGLE_ADS_PLATFORM)
      .not("converted_at", "is", null)
      .is("uploaded_at", null)
      .limit(MAX_BATCH),
    supabase.from("ads_accounts").select("currency_code").eq("platform", GOOGLE_ADS_PLATFORM).maybeSingle(),
  ]);

  const rows = (attrs ?? []) as AttributionRow[];
  if (rows.length === 0) return { configured: true, uploaded: 0, skipped: 0, failed: 0 };

  const currency = (account as { currency_code?: string } | null)?.currency_code ?? "USD";
  const definitions = await getConversionDefinitions();
  const nowIso = new Date().toISOString();

  const { toUpload, skips } = buildUploadBatch(rows, definitions, currency);
  const skipped = skips.length;
  // Mark skipped rows terminal (with the reason) so they aren't retried forever.
  for (const s of skips) {
    await supabase.from("ad_click_attributions")
      .update({ uploaded_at: nowIso, upload_status: "skipped", upload_error: s.reason })
      .eq("id", s.id);
  }

  if (toUpload.length === 0) return { configured: true, uploaded: 0, skipped, failed: 0 };

  const token = await mintGoogleAdsAccessToken(config);
  const response = await uploadClickConversions(config, token, toUpload.map((t) => t.conversion));
  const failedIdx = response.partialFailureError ? failedIndicesFromPartialError(response.partialFailureError) : new Set<number>();

  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < toUpload.length; i++) {
    const { row } = toUpload[i];
    if (failedIdx.has(i)) {
      failed++;
      await supabase.from("ad_click_attributions")
        .update({ uploaded_at: nowIso, upload_status: "failed", upload_error: "partial-failure from Google Ads" })
        .eq("id", row.id);
    } else {
      uploaded++;
      await supabase.from("ad_click_attributions")
        .update({ uploaded_at: nowIso, upload_status: "uploaded", upload_error: null })
        .eq("id", row.id);
    }
  }

  return { configured: true, uploaded, skipped, failed };
}
