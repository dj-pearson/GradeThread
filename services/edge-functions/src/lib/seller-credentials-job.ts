// US-1126: impure loaders for the verified-seller credential block.
//
// Pulls the seller's certified-grade stats + verified-profile eligibility from
// the DB and renders the buyer-facing block via the PURE builder
// (seller-credentials.ts). Kept separate from the pure renderer so the renderer
// unit-tests without the supabase/env dance.

import { supabaseAdmin } from "./supabase.ts";
import {
  buildSellerCredentialBlock,
  DEFAULT_SITE,
  type SellerCredential,
  type SellerCredentialBlock,
  type SellerCredentialStats,
} from "./seller-credentials.ts";

/**
 * Count + average of a user's certified (public) grades. Certified == the report
 * has a public certificate_id; ownership flows through submissions.user_id since
 * grade_reports has no user_id column. Shared by the Verified profile endpoint
 * (verified.ts) and the listing-credential embed so the two never drift.
 */
export async function loadSellerGradeStats(
  userId: string,
): Promise<SellerCredentialStats> {
  const { data } = await supabaseAdmin
    .from("grade_reports")
    .select("overall_score, submissions!inner(user_id)")
    .eq("submissions.user_id", userId)
    .not("certificate_id", "is", null)
    .limit(1000);
  const rows = (data ?? []) as unknown as { overall_score: number }[];
  const total = rows.length;
  const avg = total > 0
    ? Math.round(
      (rows.reduce((a, r) => a + Number(r.overall_score), 0) / total) * 10,
    ) / 10
    : 0;
  return { total_graded: total, average_grade: avg };
}

interface VerifiedRow {
  verified_handle: string | null;
  verified_display_name: string | null;
  verified_enabled: boolean | null;
  verified_embed_in_listings: boolean | null;
}

/**
 * Impure: load the seller's credential DATA, or null when they are NOT eligible
 * (profile not public, no handle claimed, or the per-seller embed opt-in is
 * off). Best-effort — any error returns null so a listing build never fails on
 * the trust block. Tenant-safe: scoped to the passed owner id.
 *
 * Split out of loadSellerCredentialBlock for US-2958: the description renderer
 * needs the unrendered credential, because rendering it is the one thing the
 * block renderer must own. Two callers, one query.
 */
export async function loadSellerCredential(
  ownerId: string,
): Promise<SellerCredential | null> {
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select(
        "verified_handle, verified_display_name, verified_enabled, verified_embed_in_listings",
      )
      .eq("id", ownerId)
      .maybeSingle();
    const row = data as VerifiedRow | null;
    // Only when the seller is publicly verified, has a handle, and opted in.
    if (!row || !row.verified_enabled || !row.verified_handle) return null;
    if (!row.verified_embed_in_listings) return null;

    const stats = await loadSellerGradeStats(ownerId);
    return {
      handle: row.verified_handle,
      display_name: row.verified_display_name,
      stats,
    };
  } catch (err) {
    console.error("[seller-credentials] loadSellerCredential failed:", err);
    return null;
  }
}

/**
 * Impure: load the RENDERED credential block for a seller, or null when they are
 * not eligible. Thin wrapper over loadSellerCredential.
 */
export async function loadSellerCredentialBlock(
  ownerId: string,
  siteUrl: string = DEFAULT_SITE,
): Promise<SellerCredentialBlock | null> {
  const cred = await loadSellerCredential(ownerId);
  return cred ? buildSellerCredentialBlock(cred, siteUrl) : null;
}
