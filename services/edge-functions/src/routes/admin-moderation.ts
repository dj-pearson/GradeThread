import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  closeFlagForContent,
  enqueueModerationFlag,
  listingRestorePatch,
  listingTakedownPatch,
  type ModerationContentType,
  photoHidePatch,
  photoRestorePatch,
  resolveListingOwner,
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
adminModerationRoutes.post("/:id/approve", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "approved" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

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
adminModerationRoutes.post("/:id/reject", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const sub = await loadSubmission(id);
  if (!sub) return c.json({ error: "Submission not found" }, 404);

  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

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
adminModerationRoutes.post("/:id/ban", async (c: Context<AdminEnv>) => {
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
  if (banErr) return c.json({ error: banErr.message }, 500);

  // Banning over a submission also rejects that submission.
  const { error: subErr } = await supabaseAdmin
    .from("submissions")
    .update({ flagged: false, moderation_status: "rejected", status: "failed" })
    .eq("id", id);
  if (subErr) return c.json({ error: subErr.message }, 500);

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
  if (error) return c.json({ error: error.message }, 500);
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
  if (error) return c.json({ error: error.message }, 500);
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

// POST /listings/:id/takedown — unpublish a listing platform-wide. Destructive
// (removes public/marketplace content) → fresh MFA step-up. Reversible: restore
// flips the markers back.
adminModerationRoutes.post("/listings/:id/takedown", async (c: Context<AdminEnv>) => {
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
  if (error) return c.json({ error: error.message }, 500);

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
adminModerationRoutes.post("/listings/:id/restore", async (c: Context<AdminEnv>) => {
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
  if (error) return c.json({ error: error.message }, 500);

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
adminModerationRoutes.post("/photos/:id/hide", async (c: Context<AdminEnv>) => {
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
  if (error) return c.json({ error: error.message }, 500);

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
adminModerationRoutes.post("/photos/:id/unhide", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const ownerUserId = await resolvePhotoOwner(id);
  if (!ownerUserId) return c.json({ error: "Photo not found" }, 404);

  const patch = photoRestorePatch();
  const { error } = await supabaseAdmin
    .from("item_photos")
    .update(patch)
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

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
  const body = (await c.req.json().catch(() => ({}))) as NotifyBody;
  const contentType = body.content_type;
  const contentId = body.content_id;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (contentType !== "listing" && contentType !== "photo") {
    return c.json({ error: "`content_type` must be 'listing' or 'photo'" }, 400);
  }
  if (typeof contentId !== "string" || !contentId) {
    return c.json({ error: "`content_id` is required" }, 400);
  }
  if (!message) return c.json({ error: "`message` is required" }, 400);

  const ownerUserId = contentType === "listing"
    ? await resolveListingOwner(contentId)
    : await resolvePhotoOwner(contentId);
  if (!ownerUserId) return c.json({ error: "Content not found" }, 404);

  await notifyUser(ownerUserId, {
    type: "system",
    title: "Content moderation notice",
    message,
    link: contentType === "listing" ? "/dashboard/flipdesk/pipeline" : null,
  });
  await writeAuditLog(c, {
    action: "admin.moderation_notify_owner",
    targetType: contentType === "listing" ? "listing" : "item_photo",
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
  if (contentType !== "listing" && contentType !== "photo") {
    return c.json({ error: "`content_type` must be 'listing' or 'photo'" }, 400);
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
    targetType: contentType === "listing" ? "listing" : "item_photo",
    targetId: contentId,
    details: { flag_id: flagId, reason, source },
  });
  return c.json({ ok: true, flag_id: flagId });
});
