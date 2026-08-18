// US-1811: buyer rewards — purchase-link + arrival-condition capture.
//
// The FIRST /api/buyer/* route. Personal account (no workspace middleware), so
// ownership is the authenticated user directly: `const userId = c.get("userId")`
// (NOT workspaceOwnerId — the buyer plan is per-account). Every query on the
// tenant tables is scoped `.eq("user_id", userId)`; a cross-tenant id hits 0
// rows and returns 404 (US-268). Arrival images run through the hardened upload
// pipeline (validate magic-bytes → strip EXIF → PRIVATE submission-images bucket).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { normalizeCertNumber } from "../lib/cert-number.ts";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { snapshotCoverageForPurchase } from "../lib/buyer-guarantee-coverage.ts";
import { recordBuyerGradeOutcome } from "../lib/buyer-grade-confirmation.ts";
import { fileBuyerGuaranteeClaim } from "../lib/buyer-guarantee-claim.ts";
import { requireBuyerFeature } from "../lib/buyer-entitlements.ts";
import { summarizeUserImpact } from "../lib/impact-estimate.ts";

export const ARRIVAL_IMAGE_TYPES = ["front", "back", "label", "detail"] as const;
export type ArrivalImageType = (typeof ARRIVAL_IMAGE_TYPES)[number];

export function isArrivalImageType(v: unknown): v is ArrivalImageType {
  return typeof v === "string" && (ARRIVAL_IMAGE_TYPES as readonly string[]).includes(v);
}

/** Object path for an arrival capture in the private submission-images bucket.
 *  {userId}/{purchaseId}/arrival_{type}_{timestamp}.{ext} — the leading folder
 *  is the userId so the bucket's per-user-folder RLS enforces tenancy. Pure. */
export function arrivalStoragePath(
  userId: string,
  purchaseId: string,
  imageType: ArrivalImageType,
  ext: string,
  timestamp: number,
): string {
  return `${userId}/${purchaseId}/arrival_${imageType}_${timestamp}.${ext}`;
}

/** Strip a `data:<mime>;base64,` prefix and decode to bytes. Returns null on a
 *  malformed / non-base64 payload. Magic-byte validation happens downstream, so
 *  the declared mime is not trusted. Pure. */
export function decodeDataUrl(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 && dataUrl.slice(0, comma).includes("base64")
    ? dataUrl.slice(comma + 1)
    : dataUrl;
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length === 0) return null;
  try {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

type BuyerEnv = { Variables: { userId: string } };

export const buyerPurchasesRoutes = new Hono<BuyerEnv>();

// Link a purchase to an existing PUBLIC certificate + record context.
buyerPurchasesRoutes.post("/purchases", async (c) => {
  const userId = c.get("userId");
  let body: {
    cert_number?: string;
    purchase_price_cents?: number | null;
    marketplace?: string | null;
    purchased_at?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const certNumber = normalizeCertNumber(body.cert_number ?? "");
  if (!certNumber || certNumber === "GT-") {
    return c.json({ error: "A certificate number is required." }, 400);
  }

  // Resolve the cert with the PUBLIC predicate (certificate_id set) then confirm
  // it isn't withheld — the same gate the public cert lookup uses.
  const { data: report, error: repErr } = await supabaseAdmin
    .from("grade_reports")
    .select("id, certificate_id, submission_id, overall_score, grade_tier")
    .eq("certificate_number", certNumber)
    .not("certificate_id", "is", null)
    .maybeSingle();
  if (repErr) return c.json({ error: "Lookup failed." }, 500);
  if (!report) return c.json({ error: "No public certificate matches that number." }, 404);

  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("title, brand, flagged, moderation_status, status")
    .eq("id", report.submission_id)
    .maybeSingle();
  if (!sub || isCertificateWithheld(sub)) {
    return c.json({ error: "No public certificate matches that number." }, 404);
  }

  const price = body.purchase_price_cents;
  const row = {
    user_id: userId,
    grade_report_id: report.id,
    certificate_id: report.certificate_id,
    purchase_price_cents: typeof price === "number" && price >= 0 ? Math.round(price) : null,
    marketplace: body.marketplace?.trim() || null,
    purchased_at: body.purchased_at || null,
    brand: sub.brand,
    title: sub.title,
  };
  // Upsert on (user_id, grade_report_id): re-linking the same cert updates the
  // context rather than erroring or duplicating.
  const { data: purchase, error: insErr } = await supabaseAdmin
    .from("buyer_purchases")
    .upsert(row as never, { onConflict: "user_id,grade_report_id" })
    .select("id, certificate_id, brand, title, purchase_price_cents, marketplace, purchased_at")
    .single();
  if (insErr) return c.json({ error: "Could not save the purchase." }, 500);

  // US-1820: snapshot guarantee coverage at link time (frozen against a later
  // downgrade). Best-effort — never blocks the purchase link.
  const coverage = await snapshotCoverageForPurchase(userId, (purchase as { id: string }).id);
  return c.json({ ok: true, purchase, coverage });
});

// ── GET /guarantee-coverage ───────────────────────────────────────
// US-2503 AC2: the buyer’s purchase-guarantee coverage, joined and resolved.
//
// The web builds this view from FIVE parallel RLS reads in
// use-buyer-purchases.ts and joins them in the browser. That is fine for one
// client; asking iOS to reproduce a five-way client-side join is asking for a
// second implementation of the same join, which is where two clients start to
// disagree about what a buyer is covered for.
//
// This returns only what a COVERAGE view needs — not the arrival captures, not
// the dispute text. A screen that shows what you are covered for has no reason
// to carry the photographs.
//
// TENANCY (US-268): every read is .eq("user_id", userId) from the token. The
// child reads are additionally keyed on purchase ids that came out of the
// owner-scoped parent read, so a foreign purchase id cannot be reached even if
// one were supplied — and none is: the route takes no input at all.
//
// GATED on the purchaseGuarantee entitlement, like every other guarantee route.
// Reading coverage you do not have is not harmful, but answering as though you
// might be covered is: a buyer who reads a window and a cap will believe they
// have one.
buyerPurchasesRoutes.get("/guarantee-coverage", async (c) => {
  const userId = c.get("userId");
  const gate = await requireBuyerFeature(c, "purchaseGuarantee");
  if (gate instanceof Response) return gate;

  const { data: purchaseRows, error } = await supabaseAdmin
    .from("buyer_purchases")
    .select("id, brand, title, certificate_id, purchase_price_cents, purchased_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[buyer-purchases] coverage read failed:", error.message);
    return c.json({ error: "Could not load your coverage." }, 500);
  }
  const purchases = (purchaseRows ?? []) as Array<{
    id: string;
    brand: string | null;
    title: string | null;
    certificate_id: string;
    purchase_price_cents: number | null;
    purchased_at: string | null;
  }>;
  if (purchases.length === 0) return c.json({ purchases: [] });

  const ids = purchases.map((p) => p.id);
  const [coverageRes, claimRes] = await Promise.all([
    supabaseAdmin
      .from("purchase_coverage")
      .select(
        "purchase_id, eligible, ineligible_reason, window_days, payout_cap_cents, " +
          "grade_delta_threshold, covered_until",
      )
      .eq("user_id", userId)
      .in("purchase_id", ids),
    supabaseAdmin
      .from("buyer_guarantee_claims")
      .select("purchase_id, status, remedy_cents, remedy_credits")
      .eq("user_id", userId)
      .in("purchase_id", ids),
  ]);

  type CoverageRow = {
    purchase_id: string;
    eligible: boolean;
    ineligible_reason: string | null;
    window_days: number;
    payout_cap_cents: number;
    grade_delta_threshold: number;
    covered_until: string | null;
  };
  type ClaimRow = {
    purchase_id: string;
    status: string;
    remedy_cents: number;
    remedy_credits: number;
  };
  const coverageById = new Map<string, CoverageRow>(
    ((coverageRes.data ?? []) as unknown as CoverageRow[]).map((r) => [r.purchase_id, r]),
  );
  const claimById = new Map<string, ClaimRow>(
    ((claimRes.data ?? []) as unknown as ClaimRow[]).map((r) => [r.purchase_id, r]),
  );

  return c.json({
    purchases: purchases.map((p) => ({
      id: p.id,
      brand: p.brand,
      title: p.title,
      certificateId: p.certificate_id,
      purchasePriceCents: p.purchase_price_cents,
      purchasedAt: p.purchased_at,
      // null means no snapshot was taken — DISTINCT from eligible:false, which
      // means one was taken and it said no. The client must not render the two
      // the same way: "not covered" and "we do not know yet" are different
      // answers to "am I covered".
      coverage: coverageById.get(p.id) ?? null,
      claim: claimById.get(p.id) ?? null,
    })),
  }, 200, { "Cache-Control": "no-store, private" });
});

// US-1842: the buyer's circularity impact — aggregated across their CONFIRMED
// purchases (items they bought secondhand + verified kept in circulation). Reuses
// the US-1785 methodology (summarizeUserImpact) — no new impact model. Scoped by
// user_id (US-268).
buyerPurchasesRoutes.get("/impact", async (c) => {
  const userId = c.get("userId");

  // Confirmed buyer_arrival outcomes → the graded reports the buyer verified.
  const { data: confirmed } = await supabaseAdmin
    .from("grade_outcomes")
    .select("grade_report_id")
    .eq("buyer_user_id", userId)
    .eq("source", "buyer_arrival")
    .eq("match_status", "confirmed");
  const reportIds = [...new Set((confirmed ?? []).map((r) => (r as { grade_report_id: string }).grade_report_id))];
  if (reportIds.length === 0) {
    return c.json({ impact: await summarizeUserImpact({}), confirmedItems: 0 });
  }

  const { data: reports } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id")
    .in("id", reportIds);
  const submissionIds = [...new Set((reports ?? []).map((r) => (r as { submission_id: string }).submission_id))];

  const { data: subs } = await supabaseAdmin
    .from("submissions")
    .select("id, garment_category")
    .in("id", submissionIds);

  // Category counts — one per confirmed report (dedup already applied above).
  const catBySubmission = new Map<string, string>();
  for (const s of subs ?? []) {
    catBySubmission.set((s as { id: string }).id, (s as { garment_category: string | null }).garment_category ?? "");
  }
  const typeCounts: Record<string, number> = {};
  for (const r of reports ?? []) {
    const cat = catBySubmission.get((r as { submission_id: string }).submission_id) ?? "";
    if (!cat) continue;
    typeCounts[cat] = (typeCounts[cat] ?? 0) + 1;
  }

  const impact = await summarizeUserImpact(typeCounts);
  return c.json({ impact, confirmedItems: reportIds.length });
});

// Upload arrival photos for an owned purchase (hardened pipeline, private bucket).
buyerPurchasesRoutes.post("/purchases/:id/arrival", async (c) => {
  const userId = c.get("userId");
  const purchaseId = c.req.param("id");

  // Ownership check FIRST — load the purchase scoped by user_id. A foreign id
  // hits 0 rows → 404 (never act on an attacker-supplied id).
  const { data: purchase } = await supabaseAdmin
    .from("buyer_purchases")
    .select("id")
    .eq("id", purchaseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!purchase) return c.json({ error: "Purchase not found." }, 404);

  let body: { images?: Array<{ image_type?: string; data_url?: string }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) return c.json({ error: "No images provided." }, 400);
  if (images.length > ARRIVAL_IMAGE_TYPES.length) {
    return c.json({ error: "Too many images." }, 400);
  }

  const saved: Array<{ image_type: string; storage_path: string }> = [];
  for (const img of images) {
    if (!isArrivalImageType(img.image_type)) {
      return c.json({ error: `Invalid image type: ${img.image_type}` }, 400);
    }
    const bytes = decodeDataUrl(img.data_url);
    if (!bytes) return c.json({ error: `Invalid image data for ${img.image_type}.` }, 400);

    // HEIC is rejected here (stripImageMetadata throws on heic) — the client
    // converts to JPEG before upload, matching the grader pipeline.
    const verdict = validateImageUpload(bytes, { allow: ["jpeg", "png", "webp"] });
    if (!verdict.ok) {
      return c.json({ error: `Invalid image (${img.image_type}): ${verdict.reason}` }, 400);
    }
    const { bytes: clean } = stripImageMetadata(bytes, verdict.format);
    const path = arrivalStoragePath(userId, purchaseId, img.image_type, verdict.ext, Date.now());

    const { error: upErr } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(path, clean, { contentType: verdict.contentType, upsert: true });
    if (upErr) return c.json({ error: `Upload failed for ${img.image_type}.` }, 500);

    const { error: rowErr } = await supabaseAdmin
      .from("purchase_arrival_captures")
      .upsert(
        { user_id: userId, purchase_id: purchaseId, image_type: img.image_type, storage_path: path } as never,
        { onConflict: "purchase_id,image_type" },
      );
    if (rowErr) return c.json({ error: `Could not record ${img.image_type}.` }, 500);
    saved.push({ image_type: img.image_type, storage_path: path });
  }

  return c.json({ ok: true, saved });
});

// US-1812: confirm (or dispute) that the arrived item matched its grade. The
// verdict fans out to grade_outcomes + human-review + Trust Score + seller Grade
// Integrity (see buyer-grade-confirmation.ts). Ownership FIRST — a foreign id
// hits 0 rows → 404 (never act on an attacker-supplied id, US-268).
buyerPurchasesRoutes.post("/purchases/:id/confirm", async (c) => {
  const userId = c.get("userId");
  const purchaseId = c.req.param("id");

  const { data: purchase } = await supabaseAdmin
    .from("buyer_purchases")
    .select("id, grade_report_id")
    .eq("id", purchaseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!purchase) return c.json({ error: "Purchase not found." }, 404);

  let body: {
    match_status?: string;
    issues?: unknown;
    dispute_reason?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  if (body.match_status !== "confirmed" && body.match_status !== "disputed") {
    return c.json({ error: "match_status must be 'confirmed' or 'disputed'." }, 400);
  }
  // A dispute needs at least a reason or a structured issue — otherwise it's an
  // empty complaint that can't feed the accuracy loop.
  if (body.match_status === "disputed") {
    const hasReason = typeof body.dispute_reason === "string" && body.dispute_reason.trim().length > 0;
    const hasIssues = Array.isArray(body.issues) && body.issues.length > 0;
    if (!hasReason && !hasIssues) {
      return c.json({ error: "A dispute needs a reason or at least one reported issue." }, 400);
    }
  }

  try {
    const result = await recordBuyerGradeOutcome({
      userId,
      purchase: purchase as { id: string; grade_report_id: string },
      verdict: {
        matchStatus: body.match_status,
        issues: body.issues,
        disputeReason: body.dispute_reason ?? null,
      },
    });
    return c.json({ ok: true, outcome: result });
  } catch (err) {
    console.error("[buyer-purchases] confirm failed:", err);
    return c.json({ error: "Could not record the confirmation." }, 500);
  }
});

// US-1821: file a Grade-Locked purchase-guarantee claim for an owned purchase.
// Ownership FIRST (foreign id → 0 rows → 404). The remedy decision rides the
// confirm evidence + frozen coverage; auto-approved claims grant reward credits.
buyerPurchasesRoutes.post("/purchases/:id/claim", async (c) => {
  // US-2359: filing a claim is the purchase guarantee, which is Guard and up.
  // The gate goes BEFORE the ownership read: a free-tier buyer should be told
  // to upgrade, not told whether some other buyer's purchase id exists.
  const gate = await requireBuyerFeature(c, "purchaseGuarantee");
  if (gate instanceof Response) return gate;
  const userId = c.get("userId");
  const purchaseId = c.req.param("id");

  const { data: purchase } = await supabaseAdmin
    .from("buyer_purchases")
    .select("id, grade_report_id, purchase_price_cents")
    .eq("id", purchaseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!purchase) return c.json({ error: "Purchase not found." }, 404);

  try {
    const result = await fileBuyerGuaranteeClaim(
      userId,
      purchase as { id: string; grade_report_id: string; purchase_price_cents: number | null },
    );
    if (!result.eligible) {
      return c.json({ error: "This purchase isn't eligible for a guarantee claim.", ...result }, 400);
    }
    return c.json({ ok: true, claim: result });
  } catch (err) {
    console.error("[buyer-purchases] claim failed:", err);
    return c.json({ error: "Could not file the claim." }, 500);
  }
});
