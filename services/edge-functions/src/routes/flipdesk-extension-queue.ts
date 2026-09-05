import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  confirmRevise,
} from "../lib/pending-revises.ts";
import {
  completeRelist,
} from "../lib/extension-relist.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  CREDENTIAL_KEYS,
  normalizeQueuePayload,
  buildListPayload,
  mergeHydratedPayload,
  LIST_REFUSAL_REASON,
  type ListPayloadPhoto,
  type ListPayloadRefusal,
} from "../lib/extension-queue.ts";
import {
  enqueueExtensionWork,
  expireStaleQueueRows,
  QUEUE_SELECT_COLS,
} from "../lib/extension-enqueue.ts";
import { getMarketplaceSpec } from "../lib/marketplace-specs.ts";

// US-2481: queue extension work from mobile, drain it on the desktop.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
// Extension-mechanism channels can only be acted on from the seller's own
// logged-in browser — that is the decision in
// vault/60-decisions/adr-no-server-side-marketplace-automation.md, and the cost
// it accepts is that a seller sourcing with only a phone cannot cross-list, and
// a delist waits for the desktop.
//
// This endpoint softens that cost without paying the price the ADR refuses. The
// phone records an INSTRUCTION — an item id, a platform, a locale key — and the
// desktop extension drains it. What it never records is a way in: no password,
// no session cookie, nothing that would let a server act as the seller. That is
// checked here AND as a CHECK constraint on the table, because a promise made
// only in prose is a promise the next feature can quietly break.
//
// TENANCY (US-268). The service-role client bypasses RLS, so every query below
// is explicitly scoped to `workspaceOwnerId ?? userId`. A queue row is addressed
// by an id the CLIENT supplies, which makes every update here the exact shape
// the isolation rule exists for: the id is filtered together with the owner, so
// a foreign id matches zero rows rather than someone else's job.

export const flipdeskExtensionQueueRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

interface QueueRow {
  id: string;
  kind: string;
  platform: string;
  inventory_item_id: string | null;
  listing_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  source: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
}

// POST / — enqueue one piece of extension work.
//
// Called from iOS, Android and the web dashboard. The desktop does NOT have to
// be awake; that is the entire point.
flipdeskExtensionQueueRoutes.post("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body." }, 400);
  }

  // US-3065: the whole path lives in lib/extension-enqueue.ts now, because the
  // Claude connector is a second caller and a second copy of five refusals
  // would be five chances to omit one. This handler is the HTTP mapping and
  // nothing else.
  const result = await enqueueExtensionWork(ownerId, body as Record<string, unknown>);

  if (!result.ok) {
    // A 500 carries the driver message in `cause` so failSafe can log it
    // without the caller ever seeing it.
    if (result.status === 500) {
      return failSafe(
        c,
        500,
        result.error,
        new Error(String(result.body?.cause ?? "unknown")),
        "flipdesk.queue.enqueue",
      );
    }
    // Everything else is a refusal the caller is entitled to read verbatim —
    // the 402 upgrade body in particular, which the frontend dialog parses.
    return c.json({ error: result.error, ...(result.body ?? {}) }, result.status as 400);
  }

  return c.json({
    queued: result.row,
    notice: result.notice,
    expiresInDays: result.expiresInDays,
  }, 201);
});

// GET / — what is outstanding, for a human to look at.
//
// This is the seller-facing view: still waiting, plus anything that expired
// undrained. The expired half is the point (AC6) — silence about work that never
// ran is how a delist quietly turns into a double sale.
flipdeskExtensionQueueRoutes.get("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const nowIso = new Date().toISOString();
  await expireStaleQueueRows(ownerId, nowIso);

  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .select(QUEUE_SELECT_COLS)
    .eq("user_id", ownerId) // US-268
    .in("status", ["queued", "claimed", "expired", "failed"])
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    return failSafe(c, 500, "Could not load the queue.", error, "flipdesk.queue.list");
  }

  const rows = await withItemTitles(ownerId, (data ?? []) as unknown as QueueRow[]);
  return c.json({
    pending: rows.filter((r) => r.status === "queued" || r.status === "claimed"),
    // Surfaced separately so a client cannot render them as "still coming".
    needsAttention: rows.filter((r) => r.status === "expired" || r.status === "failed"),
  });
});

/**
 * Name the rows (US-3048).
 *
 * A queue row is an instruction, not a description: a `list` job queued from a
 * phone is a kind, a platform and an inventory item id, and nothing more. That
 * is right for the drain, which only needs to know what to do — and useless to
 * a human, who gets "Cross-post to Poshmark" four times over and cannot tell
 * which of the four is the one they want to cancel.
 *
 * Joined HERE and not in QUEUE_SELECT_COLS on purpose. `/claim` shares those columns
 * and has no use for a title; widening the drain's payload to serve a screen it
 * never renders is how a hot path grows a cost nobody can later account for.
 *
 * Two lookups, both owner-scoped (US-268), both non-fatal: a title is a nicety
 * and a failed lookup must never take down the queue view, which is the thing
 * that tells a seller their delist never ran.
 */
async function withItemTitles(
  ownerId: string,
  rows: QueueRow[],
): Promise<(QueueRow & { item_title?: string | null })[]> {
  if (rows.length === 0) return rows;

  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
  const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))] as string[];

  const titles = new Map<string, string>();

  if (itemIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("inventory_items")
      .select("id, title")
      .eq("user_id", ownerId) // US-268
      .in("id", itemIds);
    for (const r of (data ?? []) as { id: string; title: string | null }[]) {
      if (r.title) titles.set("i:" + r.id, r.title);
    }
  }

  if (listingIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("id, listing_title")
      .eq("user_id", ownerId) // US-268
      .in("id", listingIds);
    for (const r of (data ?? []) as { id: string; listing_title: string | null }[]) {
      if (r.listing_title) titles.set("l:" + r.id, r.listing_title);
    }
  }

  return rows.map((r) => ({
    ...r,
    // The item's own title wins over the listing's: a listing title is written
    // for a marketplace's search box and is routinely 80 characters of keywords,
    // which is not what a seller scanning their own queue is looking for.
    item_title:
      (r.inventory_item_id ? titles.get("i:" + r.inventory_item_id) : null) ??
      (r.listing_id ? titles.get("l:" + r.listing_id) : null) ??
      null,
  }));
}

/**
 * US-3096: fill a claimed `list` row with the listing content the extension
 * fills the marketplace form from.
 *
 * Runs at CLAIM, not enqueue, so the desktop fills the title the seller has by
 * now — see the note above `buildListPayload`. Returns the rows to hand back
 * plus the ones that can never run, which the caller marks failed rather than
 * sending to a form they would fill with nothing.
 *
 * Tenant scope (US-268): inventory_items and listings are filtered on
 * `user_id`; item_photos has no user_id column of its own, so it is filtered by
 * the item ids the owner-scoped query returned — ownership via the parent row.
 * A queue row naming another workspace's item therefore hydrates to nothing and
 * fails as `item_missing`, which is the correct answer and not a leak.
 */
async function hydrateListRows(
  ownerId: string,
  rows: QueueRow[],
): Promise<{ rows: QueueRow[]; refused: { row: QueueRow; reason: ListPayloadRefusal }[] }> {
  const listRows = rows.filter((r) => r.kind === "list" && r.inventory_item_id);
  if (listRows.length === 0) return { rows, refused: [] };

  const requestedIds = [...new Set(listRows.map((r) => r.inventory_item_id as string))];

  // The items FIRST, scoped to the owner, because everything below is scoped by
  // what this returns. item_photos carries no user_id of its own (00008): its
  // tenant is its parent item, so the owner check has to happen here and the
  // photo query is then restricted to ids this workspace was proved to own.
  const { data: itemRows } = await supabaseAdmin
    .from("inventory_items")
    .select("id, title, brand, color, size")
    .eq("user_id", ownerId) // US-268
    .in("id", requestedIds);

  const items = new Map<string, { id: string; title: string | null; brand: string | null; color: string | null; size: string | null }>();
  for (const r of (itemRows ?? []) as { id: string; title: string | null; brand: string | null; color: string | null; size: string | null }[]) {
    items.set(r.id, r);
  }

  const ownedIds = [...items.keys()];
  const [photosRes, draftsRes] = ownedIds.length === 0
    ? [{ data: [] }, { data: [] }]
    : await Promise.all([
      supabaseAdmin
        .from("item_photos")
        // US-268 via the parent: ownedIds came out of the owner-scoped query
        // above, so no row here can belong to another workspace.
        .select("id, inventory_item_id, photo_url, sort_order")
        .in("inventory_item_id", ownedIds)
        .order("sort_order", { ascending: true }),
      supabaseAdmin
        .from("listings")
        .select(
          "inventory_item_id, platform, listing_title, listing_description, listing_price, primary_photo_id, platform_fields",
        )
        .eq("user_id", ownerId) // US-268
        .eq("platform", "ebay")
        .in("inventory_item_id", ownedIds),
    ]);

  const photos = new Map<string, ListPayloadPhoto[]>();
  for (const r of (photosRes.data ?? []) as (ListPayloadPhoto & { inventory_item_id: string })[]) {
    const list = photos.get(r.inventory_item_id) ?? [];
    list.push({ id: r.id, photo_url: r.photo_url, sort_order: r.sort_order });
    photos.set(r.inventory_item_id, list);
  }

  const drafts = new Map<string, {
    listing_title: string | null;
    listing_description: string | null;
    listing_price: number | null;
    primary_photo_id: string | null;
    platform_fields: Record<string, unknown> | null;
  }>();
  for (const r of (draftsRes.data ?? []) as (
    & { inventory_item_id: string | null; platform_fields: Record<string, unknown> | null }
    & { listing_title: string | null; listing_description: string | null; listing_price: number | null; primary_photo_id: string | null }
  )[]) {
    if (r.inventory_item_id) drafts.set(r.inventory_item_id, r);
  }

  const refused: { row: QueueRow; reason: ListPayloadRefusal }[] = [];
  const out = rows.map((row) => {
    if (row.kind !== "list" || !row.inventory_item_id) return row;
    const item = items.get(row.inventory_item_id);
    if (!item) {
      refused.push({ row, reason: "item_missing" });
      return row;
    }
    const itemPhotos = photos.get(row.inventory_item_id) ?? [];
    if (itemPhotos.length === 0) {
      refused.push({ row, reason: "no_photos" });
      return row;
    }
    const draft = drafts.get(row.inventory_item_id) ?? null;
    const spec = getMarketplaceSpec(row.platform);
    const pf = draft?.platform_fields?.[row.platform];
    const hydrated = buildListPayload({
      platform: row.platform,
      itemId: row.inventory_item_id,
      item,
      photos: itemPhotos,
      platformFields: pf && typeof pf === "object" && !Array.isArray(pf)
        ? pf as Record<string, unknown>
        : null,
      draft: draft
        ? {
          listing_title: draft.listing_title,
          listing_description: draft.listing_description,
          listing_price: draft.listing_price,
          primary_photo_id: draft.primary_photo_id,
        }
        : null,
      maxPhotos: spec?.maxPhotos ?? 12,
      platformLabel: spec?.label ?? row.platform,
    });
    return { ...row, payload: mergeHydratedPayload(row.payload ?? {}, hydrated) };
  });

  const refusedIds = new Set(refused.map((r) => r.row.id));
  return { rows: out.filter((r) => !refusedIds.has(r.id)), refused };
}

// POST /claim — the desktop extension takes the next batch.
//
// Claiming rather than plain reading is what stops two open browsers running the
// same share job twice. `claimed_by` is the extension's install id, which is not
// trusted for anything — it is a diagnostic label, and the tenant scope is what
// actually decides which rows may be touched.
flipdeskExtensionQueueRoutes.post("/claim", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const limit = Math.min(
    10,
    Math.max(1, Number((body as { limit?: unknown }).limit) || 5),
  );
  const claimedBy = String((body as { installId?: unknown }).installId ?? "")
    .slice(0, 64) || null;

  const nowIso = new Date().toISOString();
  await expireStaleQueueRows(ownerId, nowIso);

  const { data: available, error: readError } = await supabaseAdmin
    .from("extension_work_queue")
    .select(QUEUE_SELECT_COLS)
    .eq("user_id", ownerId) // US-268
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (readError) {
    return failSafe(c, 500, "Could not read the queue.", readError, "flipdesk.queue.claim");
  }

  const rows = (available ?? []) as unknown as QueueRow[];
  if (rows.length === 0) return c.json({ claimed: [] });

  const ids = rows.map((r) => r.id);
  const { data: claimed, error } = await supabaseAdmin
    .from("extension_work_queue")
    .update({ status: "claimed", claimed_at: nowIso, claimed_by: claimedBy })
    .in("id", ids)
    .eq("user_id", ownerId) // US-268 — the id list is ours, the scope proves it
    .eq("status", "queued") // lost race → the other browser keeps it
    .select(QUEUE_SELECT_COLS);

  if (error) {
    return failSafe(c, 500, "Could not claim the queue.", error, "flipdesk.queue.claim");
  }

  // US-3096: fill the `list` rows before handing them over, and fail the ones
  // that can never be filled instead of sending the extension to a form it
  // would leave blank while reporting success.
  const hydrated = await hydrateListRows(
    ownerId,
    (claimed ?? []) as unknown as QueueRow[],
  );

  for (const { row, reason } of hydrated.refused) {
    const { error: failError } = await supabaseAdmin
      .from("extension_work_queue")
      .update({
        status: "failed",
        completed_at: nowIso,
        result: { ok: false, error: LIST_REFUSAL_REASON[reason] },
      })
      .eq("id", row.id)
      .eq("user_id", ownerId); // US-268
    if (failError) {
      // Non-fatal: the row stays claimed and expires on its own clock. A drain
      // that 500s because one dead row could not be marked is worse than a
      // drain that runs the other four.
      console.error("flipdesk.queue.claim: could not fail row", row.id, failError.message);
    }
  }

  return c.json({ claimed: hydrated.rows });
});

// POST /:id/complete — the extension reports what happened.
//
// `id` is client-supplied, so it is filtered WITH the owner. A foreign id
// updates zero rows and gets a 404, which is the whole US-268 rule in one query.
flipdeskExtensionQueueRoutes.post("/:id/complete", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const ok = (body as { ok?: unknown }).ok === true;

  // Bounded, and stripped of anything credential-shaped on the way back in — a
  // result envelope is still a write from a browser extension.
  const result = normalizeQueuePayload((body as { result?: unknown }).result);
  if (result.rejectedKey) {
    return c.json({ error: `result may not contain "${result.rejectedKey}".` }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .update({
      status: ok ? "done" : "failed",
      completed_at: new Date().toISOString(),
      result: result.value,
    })
    .eq("id", id)
    .eq("user_id", ownerId) // US-268
    .select("id, status, kind, listing_id")
    .maybeSingle();

  if (error) {
    return failSafe(c, 500, "Could not record that result.", error, "flipdesk.queue.complete");
  }
  if (!data) return c.json({ error: "Not found." }, 404);

  // US-9202: a drained revise reports into the same marker the web reads. The
  // row's own listing_id is used, owner-scoped through confirmRevise; nothing
  // in the result envelope chooses which listing is confirmed.
  const done = data as { id: string; status: string; kind: string; listing_id: string | null };
  // US-9203: a drained relist whose copy went live. The new row's id is on the
  // queue row's own payload (server-built), never on the result envelope.
  if (done.kind === "relist" && ok) {
    const { data: rowData } = await supabaseAdmin
      .from("extension_work_queue")
      .select("payload")
      .eq("id", done.id)
      .eq("user_id", ownerId)
      .maybeSingle();
    const newId = (rowData as { payload?: { newListingId?: unknown } } | null)?.payload?.newListingId;
    const r = result.value as { listingUrl?: unknown };
    if (typeof newId === "string" && typeof r.listingUrl === "string" && /^https:\/\//.test(r.listingUrl)) {
      await completeRelist(ownerId, newId, r.listingUrl);
    }
  }
  if (done.kind === "revise" && done.listing_id) {
    const r = result.value as { manual?: unknown; unverified?: unknown; error?: unknown };
    await confirmRevise(ownerId, done.listing_id, {
      applied: ok,
      manual: r.manual === true,
      unverified: r.unverified === true,
      error: typeof r.error === "string" ? r.error : null,
    });
  }

  return c.json({ updated: { id: done.id, status: done.status } });
});

// DELETE /:id — the seller cancels a job they no longer want run.
flipdeskExtensionQueueRoutes.delete("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .delete()
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId) // US-268
    .select("id")
    .maybeSingle();

  if (error) {
    return failSafe(c, 500, "Could not cancel that job.", error, "flipdesk.queue.cancel");
  }
  if (!data) return c.json({ error: "Not found." }, 404);
  return c.json({ cancelled: data.id });
});

// Re-exported so the tests can assert the refused keys without reaching into
// the lib — the list IS the contract.
export { CREDENTIAL_KEYS };
