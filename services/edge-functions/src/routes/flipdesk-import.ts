import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  FILL_ITEM_FIELDS,
  type ImportRowInput,
  RUN_STALE_MS,
  MAX_IMPORT_ROWS,
  MAX_RUN_ATTEMPTS,
  fillPatch,
  listingPlatformFor,
  normalizeImportRows,
} from "../lib/inventory-import.ts";
import {
  CLOSET_FILL_ITEM_FIELDS,
  CLOSET_LISTING_FIELDS,
  isClosetImportPlatform,
} from "../lib/closet-import.ts";
import { processClosetImportRun } from "../lib/closet-import-run.ts";
import { ITEM_PHOTOS_BUCKET } from "../lib/item-photo-storage.ts";
import { isOwnedStoragePath } from "../lib/staging-path.ts";

// US-2518 — durable, reversible CSV inventory import.
//
// The import used to run as a loop in the browser, under a banner reading
// "Don't close this tab". Closing it stranded the catalog half-imported with no
// record of what had landed, and a wrong column mapping was permanent.
//
// The browser now posts the mapped rows once and gets a run id. The worker in
// this file does the writing, records one effect row per change, and the reclaim
// cron resumes a run whose container died. Every effect is reversible, so a bad
// mapping is one Undo away. Contract: the durable-jobs skill.

type ImportEnv = {
  Variables: { userId: string; workspaceOwnerId?: string };
};

export const flipdeskImportRoutes = new Hono<ImportEnv>();

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  payload: unknown;
  attempts: number;
}

/** Progress is flushed to the run row every this many processed rows. */
const HEARTBEAT_EVERY = 10;

// IMP-15: a run id is a uuid. Anything else is "not found" here rather than a
// 500 from Postgres rejecting the cast.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── POST /runs — accept a mapped file and start working on it ─────────────
flipdeskImportRoutes.post("/runs", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const userId = c.get("userId");

  let body: { rows?: unknown; origin?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return c.json({ error: "No rows to import." }, 400);
  }
  if (body.rows.length > MAX_IMPORT_ROWS) {
    return c.json(
      { error: `An import is capped at ${MAX_IMPORT_ROWS} rows.` },
      400,
    );
  }

  // Never trust the shape the browser sent: normalize to the fields an import
  // is allowed to write and drop everything else. user_id is set here, from the
  // token, and is never read off the body (US-268).
  const rows = normalizeImportRows(body.rows as ImportRowInput[]);
  if (rows.length === 0) {
    return c.json({ error: "No rows had an item title." }, 400);
  }

  const origin = typeof body.origin === "string" &&
      ["csv", "sheet", "paste"].includes(body.origin)
    ? body.origin
    : "csv";

  const { data: run, error } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .insert({
      user_id: ownerId,
      created_by: userId,
      origin,
      status: "pending",
      total_rows: rows.length,
      payload: rows,
    })
    .select("id")
    .single();

  if (error || !run) {
    console.error("[flipdesk-import] could not create run:", error?.message);
    return c.json({ error: "Could not start the import." }, 500);
  }

  const runId = (run as { id: string }).id;

  // Start immediately so the seller sees progress at once. Durability does NOT
  // depend on this promise surviving: the reclaim cron resumes the run from its
  // persisted payload if this container dies.
  void processImportRun(runId).catch((err) =>
    console.error("[flipdesk-import] background run crashed:", err)
  );

  return c.json({ run_id: runId, total_rows: rows.length }, 202);
});

// ── GET /runs — the seller's recent imports, for history and undo ─────────
flipdeskImportRoutes.get("/runs", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .select(
      "id, status, origin, total_rows, processed_rows, inserted_count, updated_count, skipped_count, failed_count, error, undone_at, created_at, updated_at",
    )
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return c.json({ error: "Could not load imports." }, 500);
  return c.json({ runs: data ?? [] });
});

// ── GET /runs/:id — progress polling ─────────────────────────────────────
flipdeskImportRoutes.get("/runs/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!UUID_RE.test(c.req.param("id"))) return c.json({ error: "Import not found" }, 404);
  const { data, error } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .select(
      "id, status, origin, total_rows, processed_rows, inserted_count, updated_count, skipped_count, failed_count, errors, error, undone_at, created_at, updated_at",
    )
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) return c.json({ error: "Could not load the import." }, 500);
  if (!data) return c.json({ error: "Import not found" }, 404);
  return c.json({ run: data });
});

/** An undo claim older than this whose run never reached "undone" is dead. */
export const UNDO_CLAIM_STALE_MS = 10 * 60 * 1000;

export function isStaleUndoClaim(undoneAt: string, nowMs: number): boolean {
  const t = Date.parse(undoneAt);
  return Number.isFinite(t) && nowMs - t > UNDO_CLAIM_STALE_MS;
}

// ── POST /runs/:id/undo — put the catalog back ───────────────────────────
//
// Items the run CREATED are deleted, along with the listing and sale rows it
// created for them. Columns the run FILLED on an existing item are restored to
// the values recorded before the write. An item that has since been published
// to a marketplace is left alone and counted, because deleting it would strand
// a live listing.
//
// IMP-05: the undo is CLAIMED with a conditional UPDATE on undone_at, so two
// clicks cannot run two undos. If any step fails the claim is released and the
// seller can press Undo again; a retry is safe because every step checks what
// is there before it acts. A column the seller edited after the import, an item
// with a sale recorded after the import, and an item since published are all
// kept and counted.
flipdeskImportRoutes.post("/runs/:id/undo", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const runId = c.req.param("id");
  if (!UUID_RE.test(runId)) return c.json({ error: "Import not found" }, 404);

  const { data: run, error: runErr } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .select("id, status, undone_at")
    .eq("id", runId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (runErr) return c.json({ error: "Could not load the import." }, 500);
  if (!run) return c.json({ error: "Import not found" }, 404);

  const r = run as { status: string; undone_at: string | null };
  if (r.status === "undone") return c.json({ error: "This import was already undone." }, 409);
  if (r.status === "pending" || r.status === "running") {
    return c.json({ error: "Wait for the import to finish first." }, 409);
  }
  // A claim whose undo never finished (the process died mid-undo) would
  // otherwise block Undo forever: undone_at set, status never "undone".
  // Past UNDO_CLAIM_STALE_MS the claim is taken over, keyed on its exact
  // value so two takeovers still cannot both win.
  const staleClaim = r.undone_at !== null && isStaleUndoClaim(r.undone_at, Date.now());
  if (r.undone_at && !staleClaim) {
    return c.json({ error: "An undo is already running for this import." }, 409);
  }

  const claimedAt = new Date().toISOString();
  const claimQuery = supabaseAdmin
    .from("flipdesk_import_runs")
    .update({ undone_at: claimedAt })
    .eq("id", runId)
    .eq("user_id", ownerId)
    .in("status", ["completed", "failed"]);
  const { data: claim, error: claimErr } = await (
    staleClaim ? claimQuery.eq("undone_at", r.undone_at!) : claimQuery.is("undone_at", null)
  )
    .select("id")
    .maybeSingle();
  if (claimErr) {
    console.error("[flipdesk-import] undo claim failed:", claimErr.message);
    return c.json({ error: "Could not start the undo." }, 500);
  }
  if (!claim) return c.json({ error: "This import was already undone." }, 409);

  const result = await undoImportRun(runId, ownerId);
  if (!result.ok || result.failedItems > 0) {
    // Release the claim so the seller can try again. Keyed on our own claim
    // time so a release can never clear someone else's.
    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({ undone_at: null })
      .eq("id", runId)
      .eq("user_id", ownerId)
      .eq("undone_at", claimedAt);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({
      error: `Undo could not finish: ${result.failedItems} step${
        result.failedItems === 1 ? "" : "s"
      } failed. Press Undo again to finish it.`,
      failed_items: result.failedItems,
      deleted_items: result.deletedItems,
      restored_items: result.restoredItems,
      kept_published: result.keptPublished,
      kept_edited: result.keptEdited,
      kept_modified: result.keptModified,
    }, 500);
  }

  await supabaseAdmin
    .from("flipdesk_import_runs")
    .update({ status: "undone" })
    .eq("id", runId)
    .eq("user_id", ownerId);

  return c.json({
    deleted_items: result.deletedItems,
    restored_items: result.restoredItems,
    kept_published: result.keptPublished,
    kept_edited: result.keptEdited,
    kept_modified: result.keptModified,
  });
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Value equality for column values read back from PostgREST. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function undoImportRun(
  runId: string,
  ownerId: string,
): Promise<
  | {
    ok: true;
    deletedItems: number;
    restoredItems: number;
    keptPublished: number;
    keptEdited: number;
    keptModified: number;
    failedItems: number;
  }
  | { ok: false; error: string }
> {
  const { data: effectRows, error } = await supabaseAdmin
    .from("flipdesk_import_effects")
    .select("id, action, inventory_item_id, listing_id, sale_id, previous")
    .eq("run_id", runId)
    // Belt and braces: the run is already owner-checked, and every effect row
    // carries the tenant too, so a mismatch can never be acted on (US-268).
    .eq("user_id", ownerId);
  if (error) return { ok: false, error: "Could not read what this import did." };

  const effects = (effectRows ?? []) as Array<{
    id: string;
    action: string;
    inventory_item_id: string | null;
    listing_id: string | null;
    sale_id: string | null;
    previous: Record<string, unknown> | null;
  }>;

  let deletedItems = 0;
  let restoredItems = 0;
  let keptPublished = 0;
  let keptEdited = 0;
  let keptModified = 0;
  let failedItems = 0;

  for (const e of effects) {
    if (!e.inventory_item_id) continue;

    if (e.action === "filled") {
      if (!e.previous || Object.keys(e.previous).length === 0) continue;
      // Restore only the columns this import wrote, to the values they held.
      // US-9201: a closet re-read may also fill condition_notes and refresh the
      // listing row (price, URL); those previous values sit under the same
      // effect row, the listing half under `_listing`.
      const listingPrevious = e.previous._listing;
      if (e.listing_id && isRecord(listingPrevious)) {
        const listingPatch: Record<string, unknown> = {};
        for (const field of CLOSET_LISTING_FIELDS) {
          if (field in listingPrevious) listingPatch[field] = listingPrevious[field];
        }
        if (Object.keys(listingPatch).length > 0) {
          const { error: lErr } = await supabaseAdmin
            .from("listings")
            .update(listingPatch)
            .eq("id", e.listing_id)
            .eq("user_id", ownerId);
          if (lErr) failedItems++;
        }
      }
      const fields = [...FILL_ITEM_FIELDS, ...CLOSET_FILL_ITEM_FIELDS].filter((f) =>
        f in e.previous!
      );
      if (fields.length === 0) continue;

      // IMP-05: `_written` is what the import put in each column. A column that
      // no longer holds it was edited by the seller afterwards, and restoring
      // over it would destroy their work. Effects written before `_written`
      // existed restore as they always did.
      const written = isRecord(e.previous._written) ? e.previous._written : null;
      const patch: Record<string, unknown> = {};
      let edited = false;
      if (written) {
        const { data: cur, error: curErr } = await supabaseAdmin
          .from("inventory_items")
          .select(fields.join(", "))
          .eq("id", e.inventory_item_id)
          .eq("user_id", ownerId)
          .maybeSingle();
        if (curErr) {
          failedItems++;
          continue;
        }
        if (!cur) continue; // the seller deleted the item; nothing to restore
        const current = cur as unknown as Record<string, unknown>;
        for (const f of fields) {
          // Already back to the old value (a retried undo): nothing to do.
          if (sameValue(current[f], e.previous[f])) continue;
          if (f in written && sameValue(current[f], written[f])) {
            patch[f] = e.previous[f];
          } else {
            edited = true;
          }
        }
      } else {
        for (const f of fields) patch[f] = e.previous[f];
      }
      if (edited) keptEdited++;
      if (Object.keys(patch).length === 0) continue;
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update(patch)
        .eq("id", e.inventory_item_id)
        .eq("user_id", ownerId);
      if (upErr) failedItems++;
      else restoredItems++;
      continue;
    }

    // action === 'inserted'
    //
    // US-9201: a closet import creates the listing row WITH its marketplace
    // id, because the listing is live over there. That row is the import's
    // own work and must not read as "the seller published this since", so it
    // is excluded from the check; any OTHER listing carrying a marketplace id
    // still keeps the item.
    let publishedQuery = supabaseAdmin
      .from("listings")
      .select("id")
      .eq("inventory_item_id", e.inventory_item_id)
      .eq("user_id", ownerId)
      .not("platform_listing_id", "is", null);
    if (e.listing_id) publishedQuery = publishedQuery.neq("id", e.listing_id);
    const { data: published, error: pubErr } = await publishedQuery.limit(1);
    if (pubErr) {
      failedItems++;
      continue;
    }
    if ((published ?? []).length > 0) {
      keptPublished++;
      continue;
    }

    // IMP-05: a sale recorded after the import is the seller's money record.
    // Sales cascade when the item is deleted, so an item with one is kept.
    // Scoped through the owner-verified parent item (US-268).
    let laterSaleQuery = supabaseAdmin
      .from("sales")
      .select("id, inventory_items!inner(user_id)")
      .eq("inventory_item_id", e.inventory_item_id)
      .eq("inventory_items.user_id", ownerId);
    if (e.sale_id) laterSaleQuery = laterSaleQuery.neq("id", e.sale_id);
    const { data: laterSales, error: saleReadErr } = await laterSaleQuery.limit(1);
    if (saleReadErr) {
      failedItems++;
      continue;
    }
    if ((laterSales ?? []).length > 0) {
      keptModified++;
      continue;
    }

    // US-9201: photos the closet import copied into item-photos go with the
    // item. The rows cascade on delete; the objects do not, so remove them
    // first (best-effort) rather than leave orphaned blobs in a public bucket.
    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("storage_path, inventory_items!inner(user_id)")
      .eq("inventory_item_id", e.inventory_item_id)
      .eq("inventory_items.user_id", ownerId);
    const paths = ((photoRows ?? []) as Array<{ storage_path: string | null }>)
      .map((p) => p.storage_path)
      .filter((p): p is string => isOwnedStoragePath(p, ownerId));
    if (paths.length > 0) {
      await supabaseAdmin.storage.from(ITEM_PHOTOS_BUCKET).remove(paths)
        .then(() => {}, () => {});
    }

    if (e.sale_id) {
      const { error: sDelErr } = await supabaseAdmin
        .from("sales")
        .delete()
        .eq("id", e.sale_id)
        .eq("inventory_item_id", e.inventory_item_id);
      if (sDelErr) {
        failedItems++;
        continue;
      }
    }
    if (e.listing_id) {
      const { error: lDelErr } = await supabaseAdmin
        .from("listings")
        .delete()
        .eq("id", e.listing_id)
        .eq("user_id", ownerId);
      if (lDelErr) {
        failedItems++;
        continue;
      }
    }
    const { data: gone, error: delErr } = await supabaseAdmin
      .from("inventory_items")
      .delete()
      .eq("id", e.inventory_item_id)
      .eq("user_id", ownerId)
      .select("id");
    if (delErr) failedItems++;
    // A retried undo finds the item already gone; that is not a second delete.
    else if ((gone ?? []).length > 0) deletedItems++;
  }

  return {
    ok: true,
    deletedItems,
    restoredItems,
    keptPublished,
    keptEdited,
    keptModified,
    failedItems,
  };
}

/**
 * IMP-03: remove an item the worker just inserted, when a later write for the
 * same row failed. Without this the item is an orphan: no effect row points at
 * it, so Undo never removes it and a resumed run inserts it a second time.
 */
async function rollbackInsertedItem(
  itemId: string,
  ownerId: string,
  listingId: string | null,
  saleId: string | null,
): Promise<void> {
  if (saleId) {
    await supabaseAdmin.from("sales").delete().eq("id", saleId).eq("inventory_item_id", itemId);
  }
  if (listingId) {
    await supabaseAdmin.from("listings").delete().eq("id", listingId).eq("user_id", ownerId);
  }
  const { error } = await supabaseAdmin
    .from("inventory_items")
    .delete()
    .eq("id", itemId)
    .eq("user_id", ownerId);
  if (error) {
    console.error("[flipdesk-import] rollback of item", itemId, "failed:", error.message);
  }
}

// ── The worker ───────────────────────────────────────────────────────────
export async function processImportRun(runId: string): Promise<void> {
  // Atomic claim: whichever container wins the conditional UPDATE owns the run.
  // A stale 'running' row is reclaimed by the cron below, which flips it back
  // to 'pending' first, so this single condition covers both paths.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .update({ status: "running", error: null })
    .eq("id", runId)
    .eq("status", "pending")
    .select("id, user_id, status, payload, attempts, errors")
    .maybeSingle();
  if (claimErr) {
    // Never swallowed — a failed claim that reads as "someone else has it"
    // would silently drop the run (US-1552).
    console.error("[flipdesk-import] claim failed:", claimErr.message);
    return;
  }
  if (!claimed) return; // another worker has it

  const run = claimed as RunRow & { errors?: unknown };
  const ownerId = run.user_id;
  const attempts = (run.attempts ?? 0) + 1;
  await supabaseAdmin
    .from("flipdesk_import_runs")
    .update({ attempts })
    .eq("id", runId);

  if (attempts > MAX_RUN_ATTEMPTS) {
    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({
        status: "failed",
        error: `Gave up after ${MAX_RUN_ATTEMPTS} attempts.`,
      })
      .eq("id", runId);
    return;
  }

  const rows = Array.isArray(run.payload)
    ? (run.payload as ImportRowInput[])
    : [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Rows already accounted for by an earlier attempt. A resumed run must not
  // re-insert what it already inserted, so the effect rows are the resume
  // marker — they are the only durable record of what landed.
  const { data: doneRows, error: doneErr } = await supabaseAdmin
    .from("flipdesk_import_effects")
    .select("row_number, action")
    .eq("run_id", runId)
    .eq("user_id", ownerId);
  if (doneErr) {
    // Without the resume marker a retry would duplicate the catalog. Leave the
    // run 'running'; the reclaim sweep resumes it once it goes stale.
    console.error("[flipdesk-import] could not read effects:", doneErr.message);
    return;
  }
  const alreadyDone = new Set<number>();
  // IMP-04: the counters are DERIVED from effect rows (00592), so a resumed
  // run reports every attempt's work, not just the last one's.
  for (
    const d of (doneRows ?? []) as Array<{ row_number: number | null; action: string }>
  ) {
    if (typeof d.row_number === "number") alreadyDone.add(d.row_number);
    if (d.action === "inserted") inserted++;
    else if (d.action === "filled") updated++;
  }
  // Errors from an earlier attempt are kept only for rows this attempt will
  // not process again; a row that failed before is retried and reports afresh.
  const errors: Array<{ row: number; message: string }> = Array.isArray(run.errors)
    ? (run.errors as Array<{ row: number; message: string }>).filter((e) =>
      typeof e?.row === "number" && alreadyDone.has(e.row)
    )
    : [];

  const heartbeat = (processed: number) =>
    bumpProgress(runId, attempts, processed, inserted, updated, skipped, errors);

  try {
    // Sources first: one get_or_create_source per distinct name.
    const sourceCache = new Map<string, string>();
    const sourceNames = Array.from(
      new Set(
        rows
          .map((r) => (typeof r.source_name === "string" ? r.source_name.trim() : ""))
          .filter((s) => s.length > 0),
      ),
    );
    for (const name of sourceNames) {
      const { data: sid, error: sErr } = await (supabaseAdmin.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: string | null; error: { message: string } | null }>)(
        "get_or_create_source",
        { p_user_id: ownerId, p_name: name, p_source_type: "other" },
      );
      if (sErr) {
        console.error(`[flipdesk-import] source "${name}":`, sErr.message);
        errors.push({ row: 0, message: `Could not create the source "${name}".` });
        continue;
      }
      if (sid) sourceCache.set(name, sid);
    }

    // Existing SKUs, so a re-import fills blanks instead of duplicating rows.
    const skus = Array.from(
      new Set(
        rows
          .map((r) => (typeof r.sku === "string" ? r.sku.trim() : ""))
          .filter((s) => s.length > 0),
      ),
    );
    const existing = new Map<string, Record<string, unknown>>();
    const lookupSelect = ["id", "sku", ...FILL_ITEM_FIELDS].join(", ");
    const CHUNK = 50;
    for (let i = 0; i < skus.length; i += CHUNK) {
      const { data, error: lookupErr } = await supabaseAdmin
        .from("inventory_items")
        .select(lookupSelect)
        .eq("user_id", ownerId)
        .in("sku", skus.slice(i, i + CHUNK));
      if (lookupErr) throw new Error(lookupErr.message);
      // The dynamic select string means supabase-js can't infer the row shape.
      for (const row of ((data ?? []) as unknown) as Array<
        Record<string, unknown>
      >) {
        const sku = row.sku;
        if (typeof sku === "string" && sku) existing.set(sku, row);
      }
    }

    // IMP-04: source and SKU setup can take a while on a big file; heartbeat
    // before the first row so a live run never reads as stale, and stop at
    // once if another worker has taken the run in the meantime.
    if (!(await heartbeat(alreadyDone.size))) return;

    const insertedSkus = new Set<string>();
    // IMP-04: SKUs this attempt already filled. A second row with the same SKU
    // must not fill again from a stale snapshot and overwrite the first fill.
    const filledSkus = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNumber = typeof row.row === "number" ? row.row : i + 2;
      if (alreadyDone.has(rowNumber)) continue;

      try {
        const sku = typeof row.sku === "string" && row.sku.trim()
          ? row.sku.trim()
          : null;

        if (sku && filledSkus.has(sku)) {
          skipped++;
        } else if (sku && existing.has(sku)) {
          // An existing SKU is FILLED, never overwritten (US-1082). The prior
          // values go on the effect row so an undo can put them back.
          const prior = existing.get(sku)!;
          const patch = fillPatch(prior, row);
          if (Object.keys(patch).length === 0) {
            skipped++;
          } else {
            const previous: Record<string, unknown> = {};
            for (const key of Object.keys(patch)) previous[key] = prior[key] ?? null;
            // IMP-05: what this import wrote, so undo can tell a column the
            // seller has since edited from one still holding the import's value.
            previous._written = patch;
            const { error: upErr } = await supabaseAdmin
              .from("inventory_items")
              .update(patch)
              .eq("id", prior.id as string)
              .eq("user_id", ownerId);
            if (upErr) throw rowDbError(upErr);
            const { error: effErr } = await supabaseAdmin.from("flipdesk_import_effects").insert({
              run_id: runId,
              user_id: ownerId,
              row_number: rowNumber,
              action: "filled",
              inventory_item_id: prior.id as string,
              previous,
            });
            if (effErr) {
              // IMP-03: an unrecorded fill cannot be undone. Put it back.
              const revert: Record<string, unknown> = {};
              for (const key of Object.keys(patch)) revert[key] = previous[key];
              await supabaseAdmin
                .from("inventory_items")
                .update(revert)
                .eq("id", prior.id as string)
                .eq("user_id", ownerId);
              throw rowDbError(effErr);
            }
            existing.set(sku, { ...prior, ...patch });
            filledSkus.add(sku);
            updated++;
          }
        } else if (sku && insertedSkus.has(sku)) {
          // A duplicate SKU inside the same file: the first row created it and
          // there is nothing blank left to fill.
          skipped++;
        } else {
          const sourceId = row.source_name
            ? sourceCache.get(row.source_name.trim()) ?? null
            : null;
          const { data: itemRow, error: itemErr } = await supabaseAdmin
            .from("inventory_items")
            .insert({
              user_id: ownerId,
              title: row.title,
              sku,
              container: row.container ?? null,
              description: row.description ?? null,
              brand: row.brand ?? null,
              style: row.style ?? null,
              size: row.size ?? null,
              condition_notes: row.condition_notes ?? null,
              item_category: row.item_category ?? null,
              source_id: sourceId,
              sourced_by: row.sourced_by ?? null,
              acquired_date: row.acquired_date ?? null,
              acquired_price: row.acquired_price ?? null,
              status: row.status ?? "acquired",
              comp_set: row.comps_note ? [{ price: 0, notes: row.comps_note }] : [],
            })
            .select("id")
            .single();

          if (itemErr) {
            // A unique-SKU conflict means a concurrent import got there first.
            if ((itemErr as { code?: string }).code === "23505" && sku) {
              insertedSkus.add(sku);
              skipped++;
              if (!(await heartbeat(i + 1))) return;
              continue;
            }
            throw rowDbError(itemErr);
          }

          const itemId = (itemRow as { id: string }).id;

          // IMP-03: everything after the item insert is one unit with it. If
          // the listing, the sale or the effect row fails, the item goes too,
          // so no row is left that Undo cannot see.
          let listingId: string | null = null;
          let saleId: string | null = null;
          try {
            if (row.listing) {
              const { data: lRow, error: lErr } = await supabaseAdmin
                .from("listings")
                .insert({
                  inventory_item_id: itemId,
                  // Set explicitly (the tenant trigger would derive the same
                  // value) so the rollback's owner-scoped delete matches it.
                  user_id: ownerId,
                  // IMP-08: the marketplace the row names or its URL points
                  // at, else 'other'. Never eBay by default: an eBay row feeds
                  // reconciliation and eBay sync.
                  platform: listingPlatformFor(row.listing),
                  // US-1077: a CSV is a linking source recorded through
                  // GradeThread, so the row stays fully editable here.
                  listing_origin: "gradethread",
                  listing_price: row.listing.listing_price ?? 0,
                  listing_url: row.listing.listing_url ?? null,
                  listed_at: row.listing.listed_at ?? undefined,
                  is_active: row.status === "listed",
                })
                .select("id")
                .single();
              if (lErr) throw rowDbError(lErr);
              listingId = (lRow as { id: string }).id;
            }

            if (row.sale) {
              const { data: sRow, error: sErr } = await supabaseAdmin
                .from("sales")
                .insert({
                  inventory_item_id: itemId,
                  user_id: ownerId,
                  sale_price: row.sale.sale_price ?? 0,
                  platform_fees: row.sale.platform_fees ?? 0,
                  tax: row.sale.tax ?? 0,
                  shipping_cost: row.sale.shipping_cost ?? 0,
                  net_profit: row.sale.net_profit ?? null,
                  payout_amount: row.sale.payout_amount ?? null,
                  tracking_number: row.sale.tracking_number ?? null,
                  sold_at: row.sale.sold_at ?? null,
                  sale_date: row.sale.sold_at ?? undefined,
                })
                .select("id")
                .single();
              if (sErr) throw rowDbError(sErr);
              saleId = (sRow as { id: string }).id;
            }

            const { error: effErr } = await supabaseAdmin.from("flipdesk_import_effects").insert({
              run_id: runId,
              user_id: ownerId,
              row_number: rowNumber,
              action: "inserted",
              inventory_item_id: itemId,
              listing_id: listingId,
              sale_id: saleId,
            });
            if (effErr) throw rowDbError(effErr);
          } catch (err) {
            await rollbackInsertedItem(itemId, ownerId, listingId, saleId);
            throw err;
          }
          if (sku) insertedSkus.add(sku);
          inserted++;
        }
      } catch (err) {
        errors.push({
          row: rowNumber,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if ((i + 1) % HEARTBEAT_EVERY === 0) {
        if (!(await heartbeat(i + 1))) return;
      }
    }

    const finished = await fencedRunUpdate(runId, attempts, {
      status: "completed",
      processed_rows: rows.length,
      inserted_count: inserted,
      updated_count: updated,
      skipped_count: skipped,
      failed_count: errors.length,
      errors: errors.slice(0, 200),
    });
    if (!finished) {
      console.warn("[flipdesk-import] run", runId, "was taken by another worker; final write skipped");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-import] run failed:", message);
    await fencedRunUpdate(runId, attempts, {
      status: "failed",
      error: "The import stopped before it finished. Anything it saved can be undone.",
      inserted_count: inserted,
      updated_count: updated,
      skipped_count: skipped,
      failed_count: errors.length,
      errors: errors.slice(0, 200),
    });
  }
}

/**
 * IMP-15: a Postgres error as a seller-readable row message. The raw text goes
 * to the log only; it names columns and constraints the seller never sees.
 */
export function friendlyRowError(err: { message: string; code?: string }): string {
  switch (err.code) {
    case "22007":
    case "22008":
      return "The date isn't a real date.";
    case "23505":
      return "This row repeats an item that is already in your catalog.";
    case "23514":
      return "A value in this row isn't allowed, such as a negative price.";
    case "22P02":
    case "22003":
      return "A number in this row couldn't be read.";
    default:
      return "This row couldn't be saved.";
  }
}

function rowDbError(err: { message: string; code?: string }): Error {
  console.error("[flipdesk-import] row write failed:", err.code ?? "", err.message);
  return new Error(friendlyRowError(err));
}

/**
 * IMP-04: a write to the run row that only lands while this worker still owns
 * the run. After a reclaim the new owner has bumped `attempts`, so the old
 * worker's writes match nothing and it stops instead of fighting over the row.
 * Returns false only when the run is no longer ours; a transient error is
 * logged and treated as still ours so a blip does not abandon the run.
 */
async function fencedRunUpdate(
  runId: string,
  attempts: number,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .update(patch)
    .eq("id", runId)
    .eq("attempts", attempts)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[flipdesk-import] run update failed:", error.message);
    return true;
  }
  return Boolean(data);
}

async function bumpProgress(
  runId: string,
  attempts: number,
  processed: number,
  inserted: number,
  updated: number,
  skipped: number,
  errors: Array<{ row: number; message: string }>,
): Promise<boolean> {
  // Also the heartbeat: the UPDATE bumps updated_at through the trigger, so a
  // live run never looks stale to the reclaim sweep.
  return await fencedRunUpdate(runId, attempts, {
    processed_rows: processed,
    inserted_count: inserted,
    updated_count: updated,
    skipped_count: skipped,
    failed_count: errors.length,
  });
}

/** IMP-06: a 'pending' run this old was never claimed (a deploy between the
 * insert and the fire-and-forget start). */
export const PENDING_STALE_MS = 60 * 1000;

// ── Reclaim cron ─────────────────────────────────────────────────────────
//
// POST /api/jobs/flipdesk-import-reclaim (job-secret gated, mounted outside the
// authed wildcard). Finds runs whose worker died and resumes them from their
// persisted payload. Idempotent: the effect rows tell a resumed run which file
// rows already landed.
export async function handleImportReclaimCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("flipdesk-import-reclaim", 600);
  if (!lock.acquired) {
    return c.json({ scanned: 0, resumed: 0, skipped: true, reason: lock.reason });
  }
  try {
    const staleBefore = new Date(Date.now() - RUN_STALE_MS).toISOString();
    const { data: staleRows, error } = await supabaseAdmin
      .from("flipdesk_import_runs")
      .select("id, attempts, origin")
      .eq("status", "running")
      .lt("updated_at", staleBefore)
      .limit(20);
    if (error) {
      console.error("[flipdesk-import] reclaim scan failed:", error.message);
      return c.json({ error: "Scan failed" }, 500);
    }

    const stale = (staleRows ?? []) as Array<{ id: string; attempts: number; origin: string }>;
    let resumed = 0;
    let abandoned = 0;
    for (const run of stale) {
      if ((run.attempts ?? 0) >= MAX_RUN_ATTEMPTS) {
        // Terminalize rather than loop for ever.
        await supabaseAdmin
          .from("flipdesk_import_runs")
          .update({
            status: "failed",
            error: `Abandoned after ${MAX_RUN_ATTEMPTS} attempts.`,
          })
          .eq("id", run.id)
          .eq("status", "running");
        abandoned++;
        continue;
      }
      // Flip back to 'pending' so processImportRun's own claim can win it. The
      // UPDATE bumps updated_at, so a second sweeper tick sees a fresh row.
      const { data: reset } = await supabaseAdmin
        .from("flipdesk_import_runs")
        .update({ status: "pending" })
        .eq("id", run.id)
        .eq("status", "running")
        .lt("updated_at", staleBefore)
        .select("id")
        .maybeSingle();
      if (!reset) continue; // lost the race
      resumeRun(run);
      resumed++;
    }

    // IMP-06: a run inserted as 'pending' whose fire-and-forget start never ran
    // (the container was replaced between the insert and the claim) has no
    // worker and never goes 'running', so the sweep above never saw it. The
    // worker's own conditional claim on status='pending' keeps this race-safe.
    const pendingBefore = new Date(Date.now() - PENDING_STALE_MS).toISOString();
    const { data: pendingRows, error: pendingErr } = await supabaseAdmin
      .from("flipdesk_import_runs")
      .select("id, attempts, origin")
      .eq("status", "pending")
      .lt("updated_at", pendingBefore)
      .limit(20);
    if (pendingErr) {
      console.error("[flipdesk-import] pending scan failed:", pendingErr.message);
    }
    const pending = (pendingRows ?? []) as Array<{ id: string; attempts: number; origin: string }>;
    for (const run of pending) {
      resumeRun(run);
      resumed++;
    }

    return c.json({ scanned: stale.length + pending.length, resumed, abandoned });
  } finally {
    await lock.release();
  }
}

function resumeRun(run: { id: string; origin: string }): void {
  // US-9201: a closet read shares the run table and the reclaim, and its
  // own worker. Dispatch on origin so a stale closet run is resumed by the
  // code that knows its payload shape, not re-read as a CSV.
  const resume = isClosetImportPlatform(run.origin)
    ? processClosetImportRun
    : processImportRun;
  void resume(run.id).catch((err) =>
    console.error("[flipdesk-import] reclaim resume crashed:", err)
  );
}
