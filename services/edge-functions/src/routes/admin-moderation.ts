import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  closeFlagForContent,
  enqueueModerationFlag,
  listingRestorePatch,
  listingTakedownPatch,
  type ModerationContentType,
  photoHidePatch,
  photoRestorePatch,
  resolveCertificateOwner,
  resolveListingOwner,
  resolveOwner,
  resolvePhotoOwner,
} from "../lib/moderation-queue.ts";

// Admin content moderation (US-476/477). Approving/rejecting a flagged
// submission, refunding the grade credit, and suspending an abusive user used to
// run as DIRECT browser-client writes from src/pages/admin/moderation.tsx —
// authz left to RLS and NO audit trail capturing WHICH admin acted. These move
// the writes server-side under the service-role client, gated by
// authMiddleware + adminAuthMiddleware (inherited from the /api/admin/* group in
// main.ts, which also enforces the standing AAL2 requirement), and every action
// writes an admin_audit_log row with the acting admin's identity (the DB trigger
// in 00046 logs users.suspended changes but cannot attribute them to an admin).
//
// Mounted at /api/admin/moderation.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminModerationRoutes = new Hono<AdminEnv>();

// US-908: moderation actions additionally require the moderation:write scope (on
// top of the inherited admin role + AAL2 + per-action step-up). admin and
// super_admin both hold it in the seed → no behavior change at launch.
adminModerationRoutes.use("*", requireScope("moderation:write"));

interface FlaggedSubmissionRow {
  id: string;
  user_id: string;
  flagged: boolean | null;
  moderation_status: string | null;
  status: string | null;
}

async function loadSubmission(id: string): Promise<FlaggedSubmissionRow | null> {
  const { data } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, flagged, moderation_status, status")
    .eq("id", id)
    .maybeSingle();
  return (data as FlaggedSubmissionRow | null) ?? null;
}

// Refund one monthly grade credit to a user (clamped at 0). Returns the new
// value, or null if the user wasn't found.
async function refundGradeCredit(userId: string): Promise<number | null> {
  const { data: u } = await supabaseAdmin
    .from("users")
    .select("grades_used_this_month")
    .eq("id", userId)
    .maybeSingle();
  if (!u) return null;
  const used = (u as { grades_used_this_month: number | null }).grades_used_this_month ?? 0;
  const refunded = Math.max(0, used - 1);
  const { error } = await supabaseAdmin
    .from("users")
    .update({ grades_used_this_month: refunded })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  return refunded;
}

// POST /:id/approve — clear the flag, mark approved.
adminModerationRoutes.post("/:id/approve", async (c: Context<AdminEnv, "/:id/approve">) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "approved" })
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't approve the item.", error, "admin.moderation.approve");

  await writeAuditLog(c, {
    action: "admin.moderation_approve",
    targetType: "submission",
    targetId: id,
    before: { flagged: sub.flagged, moderation_status: sub.moderation_status },
    after: { flagged: false, moderation_status: "approved" },
  });
  return c.json({ ok: true });
});

// POST /:id/reject — reject the submission as invalid and refund the user's
// monthly grade credit.
adminModerationRoutes.post("/:id/reject", async (c: Context<AdminEnv, "/:id/reject">) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't reject the item.", error, "admin.moderation.reject");

  let refundedTo: number | null = null;
  try {
    refundedTo = await refundGradeCredit(sub.user_id);
  } catch (err) {
    // The reject already persisted; surface the refund failure for follow-up but
    // don't 500 (the moderation decision stands).
    console.error(
      `[admin-moderation] credit refund failed for ${sub.user_id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  await writeAuditLog(c, {
    action: "admin.moderation_reject",
    targetType: "submission",
    targetId: id,
    details: { user_id: sub.user_id, grade_credit_refunded: refundedTo != null },
    before: {
      flagged: sub.flagged,
      moderation_status: sub.moderation_status,
      status: sub.status,
    },
    after: { flagged: false, moderation_status: "rejected", status: "failed" },
  });
  return c.json({ ok: true, grade_credit_refunded: refundedTo != null });
});

// POST /:id/ban — suspend the submission's owner AND reject the submission.
// Suspending an account is destructive → require a fresh MFA step-up.
adminModerationRoutes.post("/:id/ban", async (c: Context<AdminEnv, "/:id/ban">) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const actorId = c.get("userId");
  if (sub.user_id === actorId) {
    return c.json({ error: "You cannot suspend your own account." }, 400);
  }

  const { error: banErr } = await supabaseAdmin
    .from("users")
    .update({ suspended: true })
    .eq("id", sub.user_id);
  if (banErr) return failSafe(c, 500, "Couldn't ban the user.", banErr, "admin.moderation.ban");

  // Banning over a submission also rejects that submission.
  const { error: subErr } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (subErr) return failSafe(c, 500, "Couldn't update the submission.", subErr, "admin.moderation.ban.sub");

  await writeAuditLog(c, {
    action: "admin.moderation_ban",
    targetType: "user",
    targetId: sub.user_id,
    details: { submission_id: id },
    before: { suspended: false },
    after: { suspended: true },
  });
  return c.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// US-889: cross-tenant listing & photo moderation.
//
// Listings and item_photos ship to public certificates and marketplaces but had
// no operator takedown path. These endpoints list flagged/recent content
// cross-tenant (the legitimate admin use of the service-role client — reads are
// intentionally cross-tenant), and every WRITE resolves the content id -> owning
// tenant before mutating, is audited, and is reversible (a takedown sets a
// marker the restore flips back). Destructive takedowns (unpublish listing, hide
// photo) additionally require a fresh MFA step-up.
//
// Image previews use short-TTL signed URLs: item_photos live in the PUBLIC
// item-photos bucket (photo_url is already a public URL); the submission-images
// path is unused here (listings/photos are seller-intended imagery).
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

interface UserLite {
  id: string;
  email: string | null;
  full_name: string | null;
  suspended: boolean;
}

async function loadUserLabels(ids: string[]): Promise<Map<string, UserLite>> {
  const map = new Map<string, UserLite>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, suspended")
    .in("id", unique);
  for (const u of (data ?? []) as Array<{
    id: string;
    email: string | null;
    full_name: string | null;
    suspended: boolean | null;
  }>) {
    map.set(u.id, {
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      suspended: !!u.suspended,
    });
  }
  return map;
}

function paginationParams(c: Context<AdminEnv>) {
  const url = new URL(c.req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number(url.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE)) ||
        DEFAULT_PAGE_SIZE,
    ),
  );
  // 'flagged' (default) drains the moderation queue; 'recent' surfaces recently
  // changed content for proactive cross-tenant review.
  const view = url.searchParams.get("view") === "recent" ? "recent" : "flagged";
  return { page, pageSize, view, from: (page - 1) * pageSize };
}

// US-2550: one place that knows what a content type is, so the three route
// bodies cannot drift apart the way "must be 'listing' or 'photo'" already
// had (that string was copied twice and would have needed a third edit).
const MUST_BE_CONTENT_TYPE =
  "`content_type` must be 'listing', 'photo' or 'certificate'";

function isModerationContentType(v: unknown): v is ModerationContentType {
  return v === "listing" || v === "photo" || v === "certificate";
}

function auditTargetType(t: ModerationContentType): string {
  return t === "listing" ? "listing" : t === "photo" ? "item_photo" : "certificate";
}

interface FlagLite {
  id: string;
  content_id: string;
  reason: string;
  source: string;
  created_at: string;
}

// Fetch the open moderation flags for a content type, paginated. Returns the
// flags plus the total count for the page footer.
async function loadOpenFlags(
  contentType: ModerationContentType,
  from: number,
  pageSize: number,
): Promise<{ flags: FlagLite[]; total: number }> {
  const { data, count } = await supabaseAdmin
    .from("content_moderation_flags")
    .select("id, content_id, reason, source, created_at", { count: "exact" })
    .eq("content_type", contentType)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  return {
    flags: (data ?? []) as FlagLite[],
    total: count ?? (data ?? []).length,
  };
}

// GET /listings — flagged (default) or recently-changed listings, cross-tenant,
// server-side paginated, each decorated with its owner + a cover-photo preview.
adminModerationRoutes.get("/listings", async (c: Context<AdminEnv>) => {
  const { page, pageSize, view, from } = paginationParams(c);

  let listingIds: string[] = [];
  let flagByContent = new Map<string, FlagLite>();
  let total = 0;

  if (view === "flagged") {
    const { flags, total: t } = await loadOpenFlags("listing", from, pageSize);
    total = t;
    listingIds = flags.map((f) => f.content_id);
    flagByContent = new Map(flags.map((f) => [f.content_id, f]));
  }

  let listingQuery = supabaseAdmin
    .from("listings")
    .select(
      "id, user_id, inventory_item_id, listing_title, listing_url, platform, listing_price, listing_status, is_active, moderation_hidden, primary_photo_id, updated_at",
      { count: "exact" },
    );
  if (view === "flagged") {
    if (listingIds.length === 0) {
      return c.json({ rows: [], page, pageSize, total: 0, totalPages: 1 });
    }
    listingQuery = listingQuery.in("id", listingIds);
  } else {
    listingQuery = listingQuery
      .order("updated_at", { ascending: false })
      .range(from, from + pageSize - 1);
  }
  const { data: listingsRaw, count: listingCount, error } = await listingQuery;
  if (error) return failSafe(c, 500, "Couldn't load listings.", error, "admin.moderation.listings.list");
  const listings = (listingsRaw ?? []) as Array<{
    id: string;
    user_id: string;
    inventory_item_id: string;
    listing_title: string | null;
    listing_url: string | null;
    platform: string;
    listing_price: number;
    listing_status: string;
    is_active: boolean;
    moderation_hidden: boolean;
    primary_photo_id: string | null;
    updated_at: string;
  }>;
  if (view === "recent") total = listingCount ?? listings.length;

  // Cover preview: the listing's primary photo, else the first item photo.
  const itemIds = [...new Set(listings.map((l) => l.inventory_item_id))];
  const coverByItem = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: photos } = await supabaseAdmin
      .from("item_photos")
      .select("id, inventory_item_id, photo_url, is_hidden, sort_order")
      .in("inventory_item_id", itemIds)
      .order("sort_order", { ascending: true });
    for (const p of (photos ?? []) as Array<{
      id: string;
      inventory_item_id: string;
      photo_url: string;
      is_hidden: boolean;
      sort_order: number;
    }>) {
      if (p.is_hidden) continue;
      if (!coverByItem.has(p.inventory_item_id)) {
        coverByItem.set(p.inventory_item_id, p.photo_url);
      }
    }
  }
  const users = await loadUserLabels(listings.map((l) => l.user_id));

  const rows = listings.map((l) => {
    const flag = flagByContent.get(l.id) ?? null;
    return {
      id: l.id,
      ownerUserId: l.user_id,
      owner: users.get(l.user_id) ?? null,
      title: l.listing_title,
      url: l.listing_url,
      platform: l.platform,
      price: l.listing_price,
      listingStatus: l.listing_status,
      isActive: l.is_active,
      moderationHidden: l.moderation_hidden,
      previewUrl: coverByItem.get(l.inventory_item_id) ?? null,
      updatedAt: l.updated_at,
      flag: flag
        ? {
          id: flag.id,
          reason: flag.reason,
          source: flag.source,
          createdAt: flag.created_at,
        }
        : null,
    };
  });

  return c.json({
    rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// GET /photos — flagged (default) or recently-uploaded item photos, cross-tenant,
// server-side paginated, each decorated with its owner + a preview.
adminModerationRoutes.get("/photos", async (c: Context<AdminEnv>) => {
  const { page, pageSize, view, from } = paginationParams(c);

  let photoIds: string[] = [];
  let flagByContent = new Map<string, FlagLite>();
  let total = 0;

  if (view === "flagged") {
    const { flags, total: t } = await loadOpenFlags("photo", from, pageSize);
    total = t;
    photoIds = flags.map((f) => f.content_id);
    flagByContent = new Map(flags.map((f) => [f.content_id, f]));
  }

  let photoQuery = supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, photo_url, photo_type, is_hidden, created_at, inventory_items!inner(user_id)",
      { count: "exact" },
    );
  if (view === "flagged") {
    if (photoIds.length === 0) {
      return c.json({ rows: [], page, pageSize, total: 0, totalPages: 1 });
    }
    photoQuery = photoQuery.in("id", photoIds);
  } else {
    photoQuery = photoQuery
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
  }
  const { data: photosRaw, count: photoCount, error } = await photoQuery;
  if (error) return failSafe(c, 500, "Couldn't load photos.", error, "admin.moderation.photos.list");
  // The embedded relation is typed as an array by the generated types.
  const photos = (photosRaw ?? []) as unknown as Array<{
    id: string;
    inventory_item_id: string;
    photo_url: string;
    photo_type: string;
    is_hidden: boolean;
    created_at: string;
    inventory_items: { user_id: string } | { user_id: string }[] | null;
  }>;
  if (view === "recent") total = photoCount ?? photos.length;

  const ownerOf = (
    inv: { user_id: string } | { user_id: string }[] | null,
  ): string | null =>
    Array.isArray(inv) ? inv[0]?.user_id ?? null : inv?.user_id ?? null;

  const users = await loadUserLabels(
    photos.map((p) => ownerOf(p.inventory_items) ?? "").filter(Boolean),
  );

  const rows = photos.map((p) => {
    const ownerUserId = ownerOf(p.inventory_items);
    const flag = flagByContent.get(p.id) ?? null;
    return {
      id: p.id,
      inventoryItemId: p.inventory_item_id,
      ownerUserId,
      owner: ownerUserId ? users.get(ownerUserId) ?? null : null,
      photoType: p.photo_type,
      isHidden: p.is_hidden,
      previewUrl: p.is_hidden ? null : p.photo_url,
      createdAt: p.created_at,
      flag: flag
        ? {
          id: flag.id,
          reason: flag.reason,
          source: flag.source,
          createdAt: flag.created_at,
        }
        : null,
    };
  });

  return c.json({
    rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});


// GET /certificates — the buyer reports from /cert/:id (US-2550).
//
// Flagged-only, deliberately: "recently changed certificates" is not a triage
// view — a certificate is immutable once issued, so the only thing worth
// draining here is what somebody reported. Each row carries what an operator
// needs to judge it without leaving the page: the grade, the garment, the
// owner, and whether the certificate is already withheld from the public.
adminModerationRoutes.get("/certificates", async (c: Context<AdminEnv>) => {
  const { page, pageSize, from } = paginationParams(c);
  const { flags, total } = await loadOpenFlags("certificate", from, pageSize);
  if (flags.length === 0) {
    return c.json({ rows: [], page, pageSize, total: 0, totalPages: 1 });
  }

  const certIds = flags.map((f) => f.content_id);
  const { data: reportsRaw, error } = await supabaseAdmin
    .from("grade_reports")
    .select("id, certificate_id, submission_id, overall_score, grade_tier, created_at")
    .in("certificate_id", certIds);
  if (error) {
    return failSafe(c, 500, "Couldn't load reported certificates.", error, "admin.moderation.certificates.list");
  }
  const reports = (reportsRaw ?? []) as Array<{
    id: string;
    certificate_id: string;
    submission_id: string;
    overall_score: number;
    grade_tier: string;
    created_at: string;
  }>;
  const reportByCert = new Map(reports.map((r) => [r.certificate_id, r]));

  const { data: subsRaw } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, title, brand, flagged, moderation_status")
    .in("id", reports.map((r) => r.submission_id));
  const subs = (subsRaw ?? []) as Array<{
    id: string;
    user_id: string;
    title: string | null;
    brand: string | null;
    flagged: boolean | null;
    moderation_status: string | null;
  }>;
  const subById = new Map(subs.map((s) => [s.id, s]));
  const users = await loadUserLabels(subs.map((s) => s.user_id));

  const rows = flags.map((flag) => {
    const report = reportByCert.get(flag.content_id) ?? null;
    const sub = report ? subById.get(report.submission_id) ?? null : null;
    return {
      certificateId: flag.content_id,
      // Null when the grade behind a reported certificate has since been
      // deleted. The flag still shows, because the report is the audit trail
      // and hiding it would make the queue lie about what was reported.
      gradeReportId: report?.id ?? null,
      submissionId: report?.submission_id ?? null,
      overallScore: report?.overall_score ?? null,
      gradeTier: report?.grade_tier ?? null,
      issuedAt: report?.created_at ?? null,
      title: sub?.title ?? null,
      brand: sub?.brand ?? null,
      ownerUserId: sub?.user_id ?? null,
      owner: sub?.user_id ? users.get(sub.user_id) ?? null : null,
      // US-484: a submission already flagged is withheld from the public cert
      // path, so the operator can see the report has effectively been acted on.
      withheld: sub?.flagged === true || sub?.moderation_status === "flagged",
      flag: {
        id: flag.id,
        reason: flag.reason,
        source: flag.source,
        createdAt: flag.created_at,
      },
    };
  });

  return c.json({
    rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// POST /certificates/:id/dismiss — close a buyer report without acting on the
// content. NOT destructive (nothing is hidden or changed), so no step-up: the
// destructive path for a certificate is withholding its SUBMISSION, which the
// existing submission moderation endpoints already own and already step up.
adminModerationRoutes.post(
  "/certificates/:id/dismiss",
  async (c: Context<AdminEnv, "/certificates/:id/dismiss">) => {
    const certId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() : "";

    const ownerUserId = await resolveCertificateOwner(certId);
    if (!ownerUserId) return c.json({ error: "Certificate not found" }, 404);

    const actorId = c.get("userId");
    await closeFlagForContent("certificate", certId, actorId, "dismissed", "dismissed");
    await writeAuditLog(c, {
      action: "admin.moderation_certificate_dismiss",
      targetType: "certificate",
      targetId: certId,
      details: { owner_user_id: ownerUserId, note: note || null },
    });
    return c.json({ ok: true });
  },
);


// POST /certificates/:id/withhold — pull a reported certificate from the
// public path. Destructive (public content disappears) → fresh MFA step-up,
// and reversible by /restore below, which is the contract this whole module
// advertises: every write path logged, every write path undoable.
//
// The mechanism is US-484: the public cert endpoint, the SSR page and the OG
// image all 404 a certificate whose SUBMISSION is flagged. So the write lands
// on the submission — there is no separate certificate-visibility column, and
// inventing one would give the product two answers to "is this cert public".
adminModerationRoutes.post(
  "/certificates/:id/withhold",
  async (c: Context<AdminEnv, "/certificates/:id/withhold">) => {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;

    const certId = c.req.param("id");
    const submissionId = await resolveCertificateSubmission(certId);
    if (!submissionId) return c.json({ error: "Certificate not found" }, 404);
    const sub = await loadSubmission(submissionId);
    if (!sub) return c.json({ error: "Certificate not found" }, 404);

    const patch = { flagged: true, moderation_status: "flagged" };
    const { error } = await supabaseAdmin
      .from("submissions")
      .update(patch)
      .eq("id", submissionId);
    if (error) {
      return failSafe(c, 500, "Couldn't withhold the certificate.", error, "admin.moderation.certificates.withhold");
    }

    const actorId = c.get("userId");
    await closeFlagForContent("certificate", certId, actorId, "withheld");
    await writeAuditLog(c, {
      action: "admin.moderation_certificate_withhold",
      targetType: "certificate",
      targetId: certId,
      details: { submission_id: submissionId, owner_user_id: sub.user_id },
      before: { flagged: sub.flagged, moderation_status: sub.moderation_status },
      after: patch,
    });
    return c.json({ ok: true });
  },
);

// POST /certificates/:id/restore — the exact inverse. Approving is what the
// pipeline-flagged path already uses (US-476), so a certificate withheld here
// and one cleared there end in the same state rather than two near-identical
// ones nobody can tell apart later.
adminModerationRoutes.post(
  "/certificates/:id/restore",
  async (c: Context<AdminEnv, "/certificates/:id/restore">) => {
    const certId = c.req.param("id");
    const submissionId = await resolveCertificateSubmission(certId);
    if (!submissionId) return c.json({ error: "Certificate not found" }, 404);
    const sub = await loadSubmission(submissionId);
    if (!sub) return c.json({ error: "Certificate not found" }, 404);

    const patch = { flagged: false, moderation_status: "approved" };
    const { error } = await supabaseAdmin
      .from("submissions")
      .update(patch)
      .eq("id", submissionId);
    if (error) {
      return failSafe(c, 500, "Couldn't restore the certificate.", error, "admin.moderation.certificates.restore");
    }

    await writeAuditLog(c, {
      action: "admin.moderation_certificate_restore",
      targetType: "certificate",
      targetId: certId,
      details: { submission_id: submissionId, owner_user_id: sub.user_id },
      before: { flagged: sub.flagged, moderation_status: sub.moderation_status },
      after: patch,
    });
    return c.json({ ok: true });
  },
);

// certificate_id -> submission_id. Separate from resolveCertificateOwner
// because the write above needs the submission ROW, not its owner.
async function resolveCertificateSubmission(
  certificateId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id")
    .eq("certificate_id", certificateId)
    .maybeSingle();
  return (data as { submission_id: string } | null)?.submission_id ?? null;
}

// POST /listings/:id/takedown — unpublish a listing platform-wide. Destructive
// (removes public/marketplace content) → fresh MFA step-up. Reversible: restore
// flips the markers back.
adminModerationRoutes.post("/listings/:id/takedown", async (c: Context<AdminEnv, "/listings/:id/takedown">) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const ownerUserId = await resolveListingOwner(id);
  if (!ownerUserId) return c.json({ error: "Listing not found" }, 404);

  const { data: before } = await supabaseAdmin
    .from("listings")
    .select("is_active, listing_status, moderation_hidden")
    .eq("id", id)
    .maybeSingle();

  const patch = listingTakedownPatch();
  const { error } = await supabaseAdmin
    .from("listings")
    .update(patch)
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't take down the listing.", error, "admin.moderation.listings.takedown");

  const actorId = c.get("userId");
  await closeFlagForContent("listing", id, actorId, "takedown");
  await writeAuditLog(c, {
    action: "admin.moderation_listing_takedown",
    targetType: "listing",
    targetId: id,
    details: { owner_user_id: ownerUserId, reversible: true },
    before: before ?? null,
    after: patch,
  });
  return c.json({ ok: true });
});

// POST /listings/:id/restore — reverse a takedown. Non-destructive → no step-up.
adminModerationRoutes.post("/listings/:id/restore", async (c: Context<AdminEnv, "/listings/:id/restore">) => {
  const id = c.req.param("id");
  const ownerUserId = await resolveListingOwner(id);
  if (!ownerUserId) return c.json({ error: "Listing not found" }, 404);

  const { data: before } = await supabaseAdmin
    .from("listings")
    .select("is_active, listing_status, moderation_hidden")
    .eq("id", id)
    .maybeSingle();

  const patch = listingRestorePatch();
  const { error } = await supabaseAdmin
    .from("listings")
    .update(patch)
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't restore the listing.", error, "admin.moderation.listings.restore");

  await writeAuditLog(c, {
    action: "admin.moderation_listing_restore",
    targetType: "listing",
    targetId: id,
    details: { owner_user_id: ownerUserId },
    before: before ?? null,
    after: patch,
  });
  return c.json({ ok: true });
});

// POST /photos/:id/hide — hide a photo from public surfaces. Destructive → step-up.
adminModerationRoutes.post("/photos/:id/hide", async (c: Context<AdminEnv, "/photos/:id/hide">) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const ownerUserId = await resolvePhotoOwner(id);
  if (!ownerUserId) return c.json({ error: "Photo not found" }, 404);

  const patch = photoHidePatch();
  const { error } = await supabaseAdmin
    .from("item_photos")
    .update(patch)
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't hide the photo.", error, "admin.moderation.photos.hide");

  const actorId = c.get("userId");
  await closeFlagForContent("photo", id, actorId, "takedown");
  await writeAuditLog(c, {
    action: "admin.moderation_photo_hide",
    targetType: "item_photo",
    targetId: id,
    details: { owner_user_id: ownerUserId, reversible: true },
    before: { is_hidden: false },
    after: patch,
  });
  return c.json({ ok: true });
});

// POST /photos/:id/unhide — reverse a hide. Non-destructive → no step-up.
adminModerationRoutes.post("/photos/:id/unhide", async (c: Context<AdminEnv, "/photos/:id/unhide">) => {
  const id = c.req.param("id");
  const ownerUserId = await resolvePhotoOwner(id);
  if (!ownerUserId) return c.json({ error: "Photo not found" }, 404);

  const patch = photoRestorePatch();
  const { error } = await supabaseAdmin
    .from("item_photos")
    .update(patch)
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't unhide the photo.", error, "admin.moderation.photos.unhide");

  await writeAuditLog(c, {
    action: "admin.moderation_photo_unhide",
    targetType: "item_photo",
    targetId: id,
    details: { owner_user_id: ownerUserId },
    before: { is_hidden: true },
    after: patch,
  });
  return c.json({ ok: true });
});

interface NotifyBody {
  content_type?: unknown;
  content_id?: unknown;
  message?: unknown;
}

// POST /notify-owner — message the owning tenant about flagged content.
// Non-destructive (no content mutation) → audited but no step-up.
adminModerationRoutes.post("/notify-owner", async (c: Context<AdminEnv>) => {
  // US-2356 AC2: arbitrary copy to a real user from the platform address —
  // same channel as admin-messages, same reasoning.
  {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }
  const body = (await c.req.json().catch(() => ({}))) as NotifyBody;
  const contentType = body.content_type;
  const contentId = body.content_id;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!isModerationContentType(contentType)) {
    return c.json({ error: MUST_BE_CONTENT_TYPE }, 400);
  }
  if (typeof contentId !== "string" || !contentId) {
    return c.json({ error: "`content_id` is required" }, 400);
  }
  if (!message) return c.json({ error: "`message` is required" }, 400);

  const ownerUserId = await resolveOwner(contentType, contentId);
  if (!ownerUserId) return c.json({ error: "Content not found" }, 404);

  await notifyUser(ownerUserId, {
    type: "system",
    title: "Content moderation notice",
    message,
    link: contentType === "listing"
      ? "/dashboard/flipdesk/pipeline"
      : contentType === "certificate"
      ? "/dashboard/submissions"
      : null,
  });
  await writeAuditLog(c, {
    action: "admin.moderation_notify_owner",
    targetType: auditTargetType(contentType),
    targetId: contentId,
    details: { owner_user_id: ownerUserId, message },
  });
  return c.json({ ok: true });
});

interface FlagBody {
  content_type?: unknown;
  content_id?: unknown;
  reason?: unknown;
  source?: unknown;
}

// POST /flag — enqueue a listing/photo into the moderation queue. The reusable
// mechanism the fraud console + user reports call via enqueueModerationFlag();
// this is the admin-initiated entry point (source defaults to 'manual').
adminModerationRoutes.post("/flag", async (c: Context<AdminEnv>) => {
  const body = (await c.req.json().catch(() => ({}))) as FlagBody;
  const contentType = body.content_type;
  const contentId = body.content_id;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const source = typeof body.source === "string" && body.source.trim()
    ? body.source.trim()
    : "manual";
  if (!isModerationContentType(contentType)) {
    return c.json({ error: MUST_BE_CONTENT_TYPE }, 400);
  }
  if (typeof contentId !== "string" || !contentId) {
    return c.json({ error: "`content_id` is required" }, 400);
  }
  if (!reason) return c.json({ error: "`reason` is required" }, 400);

  const actorId = c.get("userId");
  const flagId = await enqueueModerationFlag({
    contentType,
    contentId,
    reason,
    source,
    flaggedBy: actorId,
  });
  if (!flagId) return c.json({ error: "Failed to enqueue flag" }, 500);

  await writeAuditLog(c, {
    action: "admin.moderation_flag",
    targetType: auditTargetType(contentType),
    targetId: contentId,
    details: { flag_id: flagId, reason, source },
  });
  return c.json({ ok: true, flag_id: flagId });
});
