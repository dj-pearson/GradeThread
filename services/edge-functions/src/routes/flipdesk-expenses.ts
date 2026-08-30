import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  validateImageUpload,
  validateReceiptUpload,
} from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import {
  encodeBase64,
  extractReceipt,
  lowConfidenceFields,
  linesReconcile,
} from "../lib/receipt-extract.ts";

// US-2228 AC2 — the receipt attached to an operating expense.
//
// WHY THIS IS AN EDGE ROUTE AND NOT A DIRECT SUPABASE UPLOAD. Every other write
// on the expenses screen is a direct supabase-js call from the browser, and this
// one deliberately is not: US-276 requires server-side magic-byte validation and
// EXIF/GPS stripping before bytes reach storage, and neither can happen in a
// client that the uploader controls. The round trip IS the validation.
//
// Everything here is scoped through the OWNING flipdesk_expenses row, loaded
// `.eq("user_id", ownerId)` before any storage call (US-268). The service-role
// client bypasses RLS, so a request-supplied expense id is never acted on until
// that load returns a row. A foreign or absent id gets 404, not 403 — the same
// answer for both, so the response cannot be used to prove a row exists.

export const flipdeskExpensesRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const BUCKET = "expense-receipts";
// The bucket is PRIVATE — short-lived signed URLs only (US-276, ≤ 900s). Written
// as a literal here on purpose: private-bucket-access_test.ts resolves the TTL
// from the same file and fails closed on anything it cannot read.
const SIGNED_URL_TTL = 15 * 60;
// Matches the bucket's file_size_limit in migration 00564. A receipt is a photo
// of a piece of paper or a one-page invoice; nothing legitimate is bigger.
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

interface OwnedExpense {
  id: string;
  user_id: string;
  receipt_path: string | null;
  receipt_mime: string | null;
}

/** Load an expense iff the caller's workspace owns it. Returns null otherwise. */
async function loadOwnedExpense(
  expenseId: string,
  ownerId: string,
): Promise<OwnedExpense | null> {
  const { data } = await supabaseAdmin
    .from("flipdesk_expenses")
    .select("id, user_id, receipt_path, receipt_mime")
    .eq("id", expenseId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return (data as OwnedExpense | null) ?? null;
}

/**
 * `{ownerId}/{expenseId}/receipt_{timestamp}.{ext}`.
 *
 * The leading segment is the OWNER id, not the caller's — a workspace member
 * uploading on the owner's behalf must write into the owner's folder, or the
 * bucket's folder convention would say the row belongs to someone the row does
 * not belong to. Exported and pure so the naming is unit-tested rather than
 * asserted.
 */
export function receiptStoragePath(
  ownerId: string,
  expenseId: string,
  ext: string,
  timestamp: number,
): string {
  return `${ownerId}/${expenseId}/receipt_${timestamp}.${ext}`;
}

// POST /extract — read a receipt BEFORE the expense exists (US-2993).
//
// WHY THIS IS NOT PART OF THE ATTACH ROUTE. Attaching needs an expense to
// attach to, so the old flow was: type vendor, date and amount by hand, save,
// then upload the photo. Extraction has to happen the other way round or it
// saves the seller nothing. So the image is validated, stripped and parked
// under the owner's STAGING prefix, and the expense is created afterwards from
// the confirmed draft.
//
// The staging path is `{ownerId}/_staging/...`, and the adopt step below checks
// that prefix BEFORE touching storage or the database. A path from a request
// body is attacker-controlled input; without the prefix check, a crafted one
// would copy another tenant's receipt onto this tenant's expense.
flipdeskExpensesRoutes.post("/extract", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "Invalid form data. Expected multipart/form-data." },
      400,
    );
  }
  const file = form.get("receipt");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "Missing receipt file" }, 400);
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  const verdict = validateReceiptUpload(raw, { maxBytes: MAX_RECEIPT_BYTES });
  if (!verdict.ok) return c.json({ error: verdict.reason }, 400);

  // A PDF cannot be sent to the vision model, but it is still a valid receipt
  // to KEEP. It stages and skips extraction rather than being refused, and the
  // response says why so the screen does not look broken.
  if (verdict.kind !== "image") {
    const path = `${ownerId}/_staging/receipt_${Date.now()}.${verdict.ext}`;
    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, raw, { contentType: verdict.contentType, upsert: true });
    if (error) {
      return failSafe(c, 500, "Upload failed.", error, "expenses.extract.upload");
    }
    return c.json({
      staging_path: path,
      draft: null,
      confidence: {},
      warning:
        "We can keep a PDF receipt but cannot read one yet. Fill the details in and it will be attached.",
    });
  }

  const image = validateImageUpload(raw, {
    maxBytes: MAX_RECEIPT_BYTES,
    allow: ["jpeg", "png", "webp"],
  });
  if (!image.ok) return c.json({ error: image.reason }, 400);
  const bytes = stripImageMetadata(raw, image.format).bytes;

  // Staged FIRST, so a model timeout does not lose the photo the seller just
  // took. They can still save the expense by hand with the receipt attached,
  // which is what AC2 asks for.
  const path = `${ownerId}/_staging/receipt_${Date.now()}.${verdict.ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: verdict.contentType, upsert: true });
  if (upErr) {
    return failSafe(c, 500, "Upload failed.", upErr, "expenses.extract.upload");
  }

  try {
    const base64 = encodeBase64(bytes);
    const extraction = await extractReceipt(
      base64,
      verdict.contentType as "image/jpeg" | "image/png" | "image/webp",
      ownerId,
    );
    return c.json({
      staging_path: path,
      draft: extraction.draft,
      confidence: extraction.confidence,
      low_confidence: lowConfidenceFields(extraction),
      lines_gap_cents: linesReconcile(extraction.draft),
      prompt_version: extraction.promptVersion,
      warning: extraction.warning,
    });
  } catch (err) {
    // AC2. The photo is already saved, so the seller loses nothing but the
    // typing. Saying so is the difference between a degraded feature and a
    // broken one.
    console.error("[expenses.extract] model call failed", err);
    return c.json({
      staging_path: path,
      draft: null,
      confidence: {},
      warning:
        "We could not read that one. Your photo is saved -- fill in the details and it will be attached.",
    });
  }
});

// POST /:id/adopt-staged — attach a previously staged receipt to a new expense.
flipdeskExpensesRoutes.post("/:id/adopt-staged", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const expenseId = c.req.param("id");

  const expense = await loadOwnedExpense(expenseId, ownerId);
  if (!expense) return c.json({ error: "Expense not found" }, 404);

  let body: { staging_path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const staged = typeof body.staging_path === "string" ? body.staging_path : "";

  // THE TENANCY CHECK, before any storage call. A path from the body is
  // attacker-controlled; without this a crafted one copies another tenant's
  // receipt onto this expense.
  if (!staged.startsWith(`${ownerId}/_staging/`)) {
    return c.json({ error: "Not your file" }, 403);
  }

  const ext = staged.split(".").pop() ?? "jpg";
  const finalPath = receiptStoragePath(ownerId, expenseId, ext, Date.now());

  const { error: moveErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .move(staged, finalPath);
  if (moveErr) {
    return failSafe(c, 500, "Couldn't attach the receipt.", moveErr, "expenses.adopt.move");
  }

  const { error: rowErr } = await supabaseAdmin
    .from("flipdesk_expenses")
    .update({
      receipt_path: finalPath,
      receipt_mime: ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`,
      receipt_uploaded_at: new Date().toISOString(),
    } as never)
    .eq("id", expenseId)
    .eq("user_id", ownerId);
  if (rowErr) {
    await supabaseAdmin.storage.from(BUCKET).remove([finalPath]);
    return failSafe(c, 500, "Couldn't attach the receipt.", rowErr, "expenses.adopt.link");
  }

  return c.json({ receipt_path: finalPath });
});

// POST /:id/receipt — attach or replace the receipt on one expense.
flipdeskExpensesRoutes.post("/:id/receipt", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const expenseId = c.req.param("id");

  // Ownership check FIRST, before the body is even read.
  const expense = await loadOwnedExpense(expenseId, ownerId);
  if (!expense) return c.json({ error: "Expense not found" }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "Invalid form data. Expected multipart/form-data." },
      400,
    );
  }
  const file = form.get("receipt");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "Missing receipt file" }, 400);
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  const verdict = validateReceiptUpload(raw, { maxBytes: MAX_RECEIPT_BYTES });
  if (!verdict.ok) return c.json({ error: verdict.reason }, 400);

  // Images are stripped of EXIF/GPS; a PDF is stored byte-for-byte, which
  // validateReceiptUpload's header explains and bounds. The explicit
  // validateImageUpload call keeps the strip on the image branch honest and is
  // what upload-pipeline-coverage_test.ts reads to prove this scope validates.
  let bytes: Uint8Array<ArrayBufferLike> = raw;
  if (verdict.kind === "image") {
    const image = validateImageUpload(raw, {
      maxBytes: MAX_RECEIPT_BYTES,
      allow: ["jpeg", "png", "webp"],
    });
    if (!image.ok) return c.json({ error: image.reason }, 400);
    bytes = stripImageMetadata(raw, image.format).bytes;
  }

  const path = receiptStoragePath(ownerId, expenseId, verdict.ext, Date.now());
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: verdict.contentType, upsert: true });
  if (upErr) {
    return failSafe(c, 500, "Receipt upload failed.", upErr, "expenses.receipt.upload");
  }

  const { error: rowErr } = await supabaseAdmin
    .from("flipdesk_expenses")
    .update({
      receipt_path: path,
      receipt_mime: verdict.contentType,
      receipt_uploaded_at: new Date().toISOString(),
    } as never)
    .eq("id", expenseId)
    .eq("user_id", ownerId);
  if (rowErr) {
    // The object is up but the row does not point at it. Remove the orphan
    // rather than leaving a private object nothing can ever reach or delete.
    await supabaseAdmin.storage.from(BUCKET).remove([path]);
    return failSafe(c, 500, "Receipt upload failed.", rowErr, "expenses.receipt.link");
  }

  // Replace, not accumulate: the previous object is unreachable the moment the
  // column moves, and a bucket of orphans is a privacy liability that grows.
  if (expense.receipt_path && expense.receipt_path !== path) {
    await supabaseAdmin.storage.from(BUCKET).remove([expense.receipt_path]);
  }

  return c.json({ receipt_path: path, receipt_mime: verdict.contentType });
});

// GET /:id/receipt — a short-lived signed URL for the owner to view/download.
flipdeskExpensesRoutes.get("/:id/receipt", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const expense = await loadOwnedExpense(c.req.param("id"), ownerId);
  if (!expense) return c.json({ error: "Expense not found" }, 404);
  if (!expense.receipt_path) {
    return c.json({ error: "No receipt attached" }, 404);
  }

  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(expense.receipt_path, SIGNED_URL_TTL);
  if (error || !data?.signedUrl) {
    return failSafe(c, 500, "Couldn't open the receipt.", error, "expenses.receipt.sign");
  }
  return c.json({
    url: data.signedUrl,
    mime: expense.receipt_mime,
    expires_in: SIGNED_URL_TTL,
  });
});

// DELETE /:id/receipt — detach and delete the object.
flipdeskExpensesRoutes.delete("/:id/receipt", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const expense = await loadOwnedExpense(c.req.param("id"), ownerId);
  if (!expense) return c.json({ error: "Expense not found" }, 404);
  if (!expense.receipt_path) return c.json({ ok: true });

  // Clear the row FIRST. If the storage delete fails afterwards the receipt is
  // already unreachable, which is the outcome the seller asked for; doing it the
  // other way round can leave the column pointing at a deleted object, and the
  // screen then offers a link that 404s.
  const { error: rowErr } = await supabaseAdmin
    .from("flipdesk_expenses")
    .update({
      receipt_path: null,
      receipt_mime: null,
      receipt_uploaded_at: null,
    } as never)
    .eq("id", expense.id)
    .eq("user_id", ownerId);
  if (rowErr) {
    return failSafe(c, 500, "Couldn't remove the receipt.", rowErr, "expenses.receipt.unlink");
  }

  await supabaseAdmin.storage.from(BUCKET).remove([expense.receipt_path]);
  return c.json({ ok: true });
});
