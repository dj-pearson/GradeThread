import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import {
  assembleUserExport,
  type ExportDb,
  type ExportStorageObject,
} from "../lib/data-export.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-903: GDPR/CCPA data-subject request workflow (operator queue).
//
// Mounted at /api/admin/compliance — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/*
// group in main.ts. These are admin-gated, intentionally CROSS-TENANT reads/
// writes (the queue spans every user's requests); the admin+MFA gate is the
// authorization boundary, like admin-support-tickets.ts / admin-users.ts.
//
// The DESTRUCTIVE action (processing a `delete` request) is additionally
// super_admin + a fresh MFA step-up, and is a STAGED ANONYMIZE/ERASE that
// retains financial/audit records per policy (documented below) rather than a
// cascade hard-delete. Every action is audited.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminComplianceRoutes = new Hono<AdminEnv>();

// US-1560: every route carries moderation:write (see lib/admin-scope-map.ts).
// US-2377: per route, not use("*") — /api/admin/compliance is the parent mount
// of /api/admin/compliance/legal, and a sub-app wildcard becomes a wildcard on
// the PARENT router, so a router-wide guard here also forced moderation:write
// onto the legal routes, which ask for content:publish instead.

const db = supabaseAdmin as unknown as CheckedUpdateClient;
const exportDb = supabaseAdmin as unknown as ExportDb;

const PAGE_SIZE = 50;
const EXPORT_BUCKET = "compliance-exports";
const SIGNED_URL_TTL = 15 * 60; // 15 minutes (CLAUDE.md: private buckets ≤ 900s)
const VALID_TYPES = new Set(["export", "delete"]);
const FILTERABLE_STATUSES = new Set([
  "received",
  "processing",
  "completed",
  "rejected",
]);

interface DataRequestRow {
  id: string;
  user_id: string;
  type: "export" | "delete";
  status: "received" | "processing" | "completed" | "rejected";
  requested_at: string;
  completed_at: string | null;
  file_path: string | null;
  requested_by: string | null;
  source: string;
  notes: string | null;
  created_at: string;
}

const SELECT_COLS =
  "id, user_id, type, status, requested_at, completed_at, file_path, " +
  "requested_by, source, notes, created_at";

// Resolve { id → { email, full_name } } for the queue without N+1 reads.
async function loadUserDirectory(
  userIds: string[],
): Promise<Map<string, { email: string | null; full_name: string | null }>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const dir = new Map<
    string,
    { email: string | null; full_name: string | null }
  >();
  if (unique.length === 0) return dir;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name")
    .in("id", unique);
  for (
    const u of (data ?? []) as Array<
      { id: string; email: string | null; full_name: string | null }
    >
  ) {
    dir.set(u.id, { email: u.email, full_name: u.full_name });
  }
  return dir;
}

// Supabase storage .remove() takes an array; chunk to stay under request limits.
async function removeAll(bucket: string, objectPaths: string[]) {
  const CHUNK = 100;
  for (let i = 0; i < objectPaths.length; i += CHUNK) {
    const slice = objectPaths.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin.storage.from(bucket).remove(slice);
    if (error) {
      console.error(
        `[admin-compliance] storage remove failed (${bucket}):`,
        error.message,
      );
    }
  }
}

// ── GET / and /data-requests — the queue (paginated, ?status= ?type=) ─────────
adminComplianceRoutes.get("/data-requests", requireScope("moderation:write"), async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam && FILTERABLE_STATUSES.has(statusParam)
    ? statusParam
    : null;
  const typeParam = c.req.query("type");
  const type = typeParam && VALID_TYPES.has(typeParam) ? typeParam : null;
  const page = Math.max(0, Number(c.req.query("page") ?? "0") || 0);

  let query = supabaseAdmin
    .from("data_requests")
    .select(SELECT_COLS, { count: "exact" })
    .order("requested_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);

  const { data, error, count } = await query;
  if (error) {
    console.error("[admin-compliance] list failed:", error.message);
    return c.json({ error: "Could not load data requests" }, 500);
  }

  const rows = (data ?? []) as unknown as DataRequestRow[];
  const dir = await loadUserDirectory(
    rows.flatMap((r) =>
      [r.user_id, r.requested_by].filter((x): x is string => Boolean(x))
    ),
  );

  const requests = rows.map((r) => ({
    ...r,
    user_email: dir.get(r.user_id)?.email ?? null,
    user_name: dir.get(r.user_id)?.full_name ?? null,
    requested_by_email: r.requested_by
      ? dir.get(r.requested_by)?.email ?? null
      : null,
  }));

  // Open (received/processing) count for the nav badge, independent of filter.
  const { count: openCount } = await supabaseAdmin
    .from("data_requests")
    .select("id", { count: "exact", head: true })
    .in("status", ["received", "processing"]);

  return c.json({
    requests,
    total: count ?? 0,
    page,
    page_size: PAGE_SIZE,
    open_count: openCount ?? 0,
  });
});

// ── GET /data-requests/count — cheap nav badge poll ──────────────────────────
adminComplianceRoutes.get("/data-requests/count", requireScope("moderation:write"), async (c) => {
  const { count, error } = await supabaseAdmin
    .from("data_requests")
    .select("id", { count: "exact", head: true })
    .in("status", ["received", "processing"]);
  if (error) {
    console.error("[admin-compliance] count failed:", error.message);
    return c.json({ open_count: 0 });
  }
  return c.json({ open_count: count ?? 0 });
});

// ── GET /data-requests/:id — full detail ─────────────────────────────────────
adminComplianceRoutes.get("/data-requests/:id", requireScope("moderation:write"), async (c) => {
  const id = c.req.param("id");
  const { data } = await supabaseAdmin
    .from("data_requests")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!data) return c.json({ error: "Request not found" }, 404);
  const r = data as unknown as DataRequestRow;
  const dir = await loadUserDirectory([r.user_id, r.requested_by ?? ""]);
  return c.json({
    request: {
      ...r,
      user_email: dir.get(r.user_id)?.email ?? null,
      user_name: dir.get(r.user_id)?.full_name ?? null,
      requested_by_email: r.requested_by
        ? dir.get(r.requested_by)?.email ?? null
        : null,
    },
  });
});

// ── POST /data-requests — admin opens a request on a user's behalf ───────────
adminComplianceRoutes.post("/data-requests", requireScope("moderation:write"), async (c) => {
  let body: { user_id?: unknown; type?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  if (!userId) return c.json({ error: "user_id is required" }, 400);
  if (!VALID_TYPES.has(type)) {
    return c.json({ error: "type must be 'export' or 'delete'" }, 400);
  }

  // Confirm the subject is a real account before enqueueing.
  const { data: subject } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (!subject) return c.json({ error: "User not found" }, 404);

  const notes = typeof body.notes === "string"
    ? body.notes.trim().slice(0, 2000)
    : null;

  const { data: inserted, error } = await supabaseAdmin
    .from("data_requests")
    .insert({
      user_id: userId,
      type,
      status: "received",
      requested_by: c.get("userId"),
      source: "admin",
      notes,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    console.error("[admin-compliance] create failed:", error?.message);
    return c.json({ error: "Failed to create request" }, 500);
  }

  const newId = (inserted as { id: string }).id;
  await writeAuditLog(c, {
    action: "compliance.data_request_create",
    targetType: "data_request",
    targetId: newId,
    details: { user_id: userId, type, source: "admin" },
  });

  return c.json({ ok: true, id: newId });
});

// ── POST /data-requests/:id/reject — decline a request (audited) ─────────────
adminComplianceRoutes.post("/data-requests/:id/reject", requireScope("moderation:write"), async (c) => {
  const id = c.req.param("id");
  let body: { reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
  if (!reason) return c.json({ error: "A rejection reason is required" }, 400);

  const { data: existing } = await supabaseAdmin
    .from("data_requests")
    .select("id, user_id, type, status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return c.json({ error: "Request not found" }, 404);
  const before = existing as Pick<DataRequestRow, "user_id" | "type" | "status">;
  if (before.status === "completed") {
    return c.json({ error: "A completed request cannot be rejected" }, 409);
  }

  try {
    await updateByIdChecked(db, "data_requests", id, {
      status: "rejected",
      notes: reason,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Request could not be updated" }, 409);
    }
    console.error("[admin-compliance] reject failed:", err);
    return c.json({ error: "Failed to reject request" }, 500);
  }

  await writeAuditLog(c, {
    action: "compliance.data_request_reject",
    targetType: "data_request",
    targetId: id,
    details: { user_id: before.user_id, type: before.type, reason },
  });

  return c.json({ ok: true });
});

// ── POST /data-requests/:id/process — run the export or the deletion ─────────
//
// EXPORT: assemble the user's rows + storage manifest into a JSON archive, upload
// it to the private compliance-exports bucket, and return a short-TTL signed URL.
//
// DELETE: super_admin + a fresh MFA step-up + an explicit confirm string. STAGED
// ANONYMIZE/ERASE (NOT a cascade hard-delete): purge the user's storage objects,
// destroy stored marketplace OAuth tokens + API keys, anonymize the PII on the
// users row and the auth account, then ban the auth login. Financial + audit
// records (sales, payout_imports, admin_audit_log, account_deletion_log, and
// this data_requests row) are RETAINED per policy — they hold no direct PII once
// the user row + storage are anonymized, and we are obligated to keep
// transaction/audit history. A non-PII account_deletion_log row is written as
// the durable proof of erasure (same record self-serve deletion writes).
adminComplianceRoutes.post("/data-requests/:id/process", requireScope("moderation:write"), async (c) => {
  const id = c.req.param("id");

  const { data: existing } = await supabaseAdmin
    .from("data_requests")
    .select("id, user_id, type, status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return c.json({ error: "Request not found" }, 404);
  const req = existing as Pick<DataRequestRow, "user_id" | "type" | "status">;
  if (req.status === "completed") {
    return c.json({ error: "This request is already completed" }, 409);
  }
  if (req.status === "rejected") {
    return c.json({ error: "A rejected request cannot be processed" }, 409);
  }

  if (req.type === "export") {
    return await processExport(c, id, req.user_id);
  }
  return await processDelete(c, id, req.user_id);
});

async function processExport(
  c: Context<AdminEnv>,
  requestId: string,
  userId: string,
): Promise<Response> {
  // Mark processing so the queue reflects in-flight work even if assembly is slow.
  await supabaseAdmin
    .from("data_requests")
    .update({ status: "processing" })
    .eq("id", requestId);

  let archive;
  try {
    archive = await assembleUserExport(exportDb, userId);
  } catch (err) {
    console.error("[admin-compliance] export assembly failed:", err);
    await supabaseAdmin
      .from("data_requests")
      .update({ status: "received" })
      .eq("id", requestId);
    return c.json({ error: "Failed to assemble export" }, 500);
  }

  // Embed per-object signed URLs so the archive is self-contained for the TTL.
  const signedObjects: Array<ExportStorageObject & { signed_url: string | null }> =
    [];
  for (const obj of archive.storage_objects) {
    const { data: signed } = await supabaseAdmin.storage
      .from(obj.bucket)
      .createSignedUrl(obj.path, SIGNED_URL_TTL);
    signedObjects.push({ ...obj, signed_url: signed?.signedUrl ?? null });
  }

  const fullArchive = { ...archive, storage_objects: signedObjects };
  const filePath = `${userId}/export-${requestId}.json`;

  const { error: upErr } = await supabaseAdmin.storage
    .from(EXPORT_BUCKET)
    .upload(filePath, new Blob([JSON.stringify(fullArchive, null, 2)], {
      type: "application/json",
    }), { upsert: true, contentType: "application/json" });
  if (upErr) {
    console.error("[admin-compliance] archive upload failed:", upErr.message);
    await supabaseAdmin
      .from("data_requests")
      .update({ status: "received" })
      .eq("id", requestId);
    return c.json({ error: "Failed to store export archive" }, 500);
  }

  try {
    await updateByIdChecked(db, "data_requests", requestId, {
      status: "completed",
      file_path: filePath,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[admin-compliance] export complete update failed:", err);
    return c.json({ error: "Failed to finalize export" }, 500);
  }

  const { data: signed } = await supabaseAdmin.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL);

  await writeAuditLog(c, {
    action: "compliance.data_request_export",
    targetType: "data_request",
    targetId: requestId,
    details: {
      user_id: userId,
      file_path: filePath,
      row_counts: {
        submissions: archive.submissions.length,
        inventory_items: archive.inventory_items.length,
        listings: archive.listings.length,
        sales: archive.sales.length,
        storage_objects: archive.storage_objects.length,
      },
    },
  });

  return c.json({
    ok: true,
    file_path: filePath,
    signed_url: signed?.signedUrl ?? null,
    expires_in: SIGNED_URL_TTL,
  });
}

async function processDelete(
  c: Context<AdminEnv>,
  requestId: string,
  userId: string,
): Promise<Response> {
  // Destructive: super_admin + fresh MFA step-up + an explicit confirm string.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin access required to process a deletion" }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  let body: { confirm?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (body.confirm !== "ERASE USER DATA") {
    return c.json(
      { error: 'Confirmation required. Send { "confirm": "ERASE USER DATA" }.' },
      400,
    );
  }

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id, email, stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();
  if (!user) return c.json({ error: "User not found" }, 404);
  const u = user as { id: string; email: string | null; stripe_customer_id: string | null };

  await supabaseAdmin
    .from("data_requests")
    .update({ status: "processing" })
    .eq("id", requestId);

  // 1. Purge storage objects (derive paths from owned rows before anonymizing).
  const [subs, items] = await Promise.all([
    supabaseAdmin.from("submissions").select("id").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("id").eq("user_id", userId),
  ]);
  const subIds = (subs.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (items.data ?? []).map((r) => (r as { id: string }).id);

  const [subImgs, itemPhotos] = await Promise.all([
    subIds.length
      ? supabaseAdmin.from("submission_images").select("storage_path").in("submission_id", subIds)
      : Promise.resolve({ data: [] as { storage_path: string }[] }),
    itemIds.length
      ? supabaseAdmin.from("item_photos").select("storage_path").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] as { storage_path: string }[] }),
  ]);
  const subImgPaths = (subImgs.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);
  const itemPhotoPaths = (itemPhotos.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);
  await removeAll("submission-images", subImgPaths);
  await removeAll("item-photos", itemPhotoPaths);

  // 2. Destroy stored credentials: marketplace OAuth tokens + API keys.
  await supabaseAdmin.from("marketplace_connections").delete().eq("user_id", userId);
  await supabaseAdmin.from("api_keys").delete().eq("user_id", userId);

  // 3. Anonymize the PII on the public users row (retain the row so financial /
  //    audit records keyed to it stay referentially intact).
  const anonEmail = `erased+${userId}@anonymized.invalid`;
  await supabaseAdmin
    .from("users")
    .update({ email: anonEmail, full_name: null, avatar_url: null })
    .eq("id", userId);

  // 4. Anonymize + ban the auth account so the credentials no longer resolve to
  //    a person and the login is disabled (without cascading the financial data).
  try {
    await supabaseAdmin.auth.admin.updateUserById(userId, {
      email: anonEmail,
      user_metadata: {},
      ban_duration: "876000h", // ~100 years
    });
  } catch (err) {
    console.error(
      "[admin-compliance] auth anonymize/ban failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 5. Durable non-PII proof of erasure (same record self-serve deletion writes).
  await supabaseAdmin.from("account_deletion_log").insert({
    deleted_user_id: userId,
    source: "admin",
    had_stripe_customer: !!u.stripe_customer_id,
    stripe_deleted: false,
    storage_purged: true,
  });

  try {
    await updateByIdChecked(db, "data_requests", requestId, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[admin-compliance] delete complete update failed:", err);
    return c.json({ error: "Erasure ran but finalizing the request failed" }, 500);
  }

  await writeAuditLog(c, {
    action: "compliance.data_request_delete",
    targetType: "data_request",
    targetId: requestId,
    details: {
      user_id: userId,
      storage_objects_purged: subImgPaths.length + itemPhotoPaths.length,
      mode: "anonymize_retain_financial",
    },
  });

  return c.json({ ok: true, mode: "anonymized" });
}

// ── GET /data-requests/:id/download — mint a fresh signed URL for the archive ─
adminComplianceRoutes.get("/data-requests/:id/download", requireScope("moderation:write"), async (c) => {
  const id = c.req.param("id");
  const { data } = await supabaseAdmin
    .from("data_requests")
    .select("id, type, status, file_path")
    .eq("id", id)
    .maybeSingle();
  if (!data) return c.json({ error: "Request not found" }, 404);
  const r = data as Pick<DataRequestRow, "type" | "status" | "file_path">;
  if (r.type !== "export" || !r.file_path) {
    return c.json({ error: "No export archive available for this request" }, 404);
  }

  const { data: signed, error } = await supabaseAdmin.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(r.file_path, SIGNED_URL_TTL);
  if (error || !signed?.signedUrl) {
    console.error("[admin-compliance] sign download failed:", error?.message);
    return c.json({ error: "Failed to generate download link" }, 500);
  }

  await writeAuditLog(c, {
    action: "compliance.data_request_download",
    targetType: "data_request",
    targetId: id,
    details: { file_path: r.file_path },
  });

  return c.json({ signed_url: signed.signedUrl, expires_in: SIGNED_URL_TTL });
});
