import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { SheetsClient } from "../lib/google-sheets-api.ts";
import {
  getGoogleAccessToken,
  isGoogleSheetsConfigured,
} from "./flipdesk-google.ts";
import {
  buildTabSetupRequests,
  type ColumnDef,
  columnLetter,
  CONFLICT_ACTION_ACCEPT_SHEET,
  CONFLICT_ACTION_KEEP,
  CONFLICT_ACTION_LOCKED,
  CONFLICT_STATUS_APPLIED,
  CONFLICT_STATUS_OPEN,
  CONFLICT_STATUS_SKIPPED,
  CONFLICTS_HEADERS,
  CONFLICTS_TAB,
  chunk,
  DATA_TABS,
  ID_HEADER,
  INVENTORY_COLUMNS,
  mergeRow,
  normalizeCell,
  parsePulledValue,
  recordToRow,
  SYNC_LOG_TAB,
  type TabDef,
} from "../lib/sheet-sync.ts";
import {
  type ConflictField,
  recordSourceObservations,
  type SourceObservation,
} from "../lib/sync-conflicts.ts";
import {
  deriveListingOrigin,
  isSheetEditLockedByEbay,
} from "../lib/sync-precedence.ts";

// Google Sheets 2-way live sync (US-147).
//
// Every run is a FULL bidirectional merge — read the whole sheet, 3-way-merge
// each row against the DB using the per-field snapshot from the last run
// (lib/sheet-sync.ts), pull allow-listed sheet edits into FlipDesk, push
// FlipDesk changes to the sheet, and flag both-sides-changed fields in the
// Conflicts tab (FlipDesk wins by default; the user can flip a row to
// "Accept Sheet" and the next run applies it). Running the merge for both the
// /sync/push and /sync/pull jobs keeps partial-direction runs from ever
// clobbering un-pulled sheet edits: a push can't overwrite a cell the merge
// knows the sheet changed.
//
// Mounted at /api/flipdesk/google (same prefix as the OAuth module):
//   POST /sync/push  — internal job auth; syncs every active connection
//   POST /sync/pull  — internal job auth; alias of push (same full merge)
//   POST /sync/now   — user-authed "Sync now" button; syncs the caller's
//                      workspace only
//
// TENANT SCOPING (US-268): every DB read/write here is scoped to the owning
// user — inventory/sources by user_id, listings/sales through
// inventory_items!inner(user_id), and pull updates carry .eq("user_id", …).
//
// PROVENANCE CARVE-OUT (US-1083, contract: SYNC_SOURCE_OF_TRUTH.md): the sync
// stays bidirectional EXCEPT for eBay-owned fields (EBAY_OWNED_LISTING_FIELDS)
// on eBay-originated listings (deriveListingOrigin === 'ebay'). A sheet edit to
// such a locked cell is NOT applied — eBay is the source of truth and would
// re-assert it anyway — the cell is rewritten from the DB and reported back to
// the user as a "skipped item" ("locked — edit on eBay"). The skip is
// field-scoped, never row-scoped. This module does NOT read the deprecated
// listings.source_of_truth pin (retired by US-1078); provenance drives it.

type GoogleEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
};

export const flipdeskGoogleSyncRoutes = new Hono<GoogleEnv>();

const ALL_TAB_TITLES = [
  ...DATA_TABS.map((t) => t.title),
  CONFLICTS_TAB,
  SYNC_LOG_TAB,
];

const VALUE_WRITE_CHUNK = 400; // ranges per values.batchUpdate call
const APPEND_CHUNK = 500; // rows per values.append call
const MAX_LOGGED_ERRORS = 20;

// US-1083: a sheet edit that was deliberately NOT applied because the cell is
// an eBay-owned field on an eBay-originated (locked) listing.
interface SkippedItem {
  tab: string;
  flipdesk_id: string;
  item: string;
  field: string;
  reason: string;
}

interface RunSummary {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
  /** Per-cell edits not applied because eBay owns the field (US-1083). */
  skippedItems: SkippedItem[];
  /** Whole-run skip (no sheet / already-running lock). */
  skipped?: string;
}

const SKIP_REASON_EBAY_LOCKED = "locked — edit on eBay";

type Row = Record<string, unknown>;

// Page through a supabase query 1000 rows at a time (PostgREST's default cap).
async function pageAll(
  build: (from: number, to: number) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
): Promise<Row[]> {
  const out: Row[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

const INVENTORY_SELECT =
  "id, sku, title, brand, size, item_category, status, acquired_price, " +
  "target_price, condition_notes, grade_value, location_bin, created_at, updated_at";
// US-1083: provenance signals (batch_id / synced_to_ebay_at / platform_listing_id)
// replace the retired listings.source_of_truth pin — they drive
// deriveListingOrigin. The persisted listing_origin column (US-1077) is NOT
// selected yet (it doesn't exist); origin is derived from these signals, which
// is exactly what US-1077 will backfill from, so behavior is forward-compatible.
const LISTINGS_SELECT =
  "id, listing_title, platform, listing_status, listing_price, watchers, " +
  "views, listing_url, listed_at, updated_at, batch_id, " +
  "synced_to_ebay_at, platform_listing_id, inventory_items!inner(user_id)";

// Listings-tab columns that participate in cross-source conflict detection
// (US-148), mapped to their flipdesk_sync_conflicts field name. The Listings
// tab has no quantity column, so quantity is eBay-vs-FlipDesk only.
const LISTING_CONFLICT_FIELDS: Record<string, ConflictField> = {
  listing_price: "price",
  listing_status: "listing_status",
  listing_title: "title",
};
const SALES_SELECT =
  "id, sale_price, platform_fees, shipping_collected, shipping_cost, " +
  "net_profit, buyer_username, sold_at, created_at, inventory_items!inner(user_id)";
const SOURCES_SELECT = "id, name, source_type, location, notes, updated_at";

function loadTabRecords(tab: string, userId: string): Promise<Row[]> {
  switch (tab) {
    case "Inventory":
      return pageAll((from, to) =>
        supabaseAdmin.from("inventory_items").select(INVENTORY_SELECT)
          .eq("user_id", userId).order("id").range(from, to)
      );
    case "Listings":
      return pageAll((from, to) =>
        supabaseAdmin.from("listings").select(LISTINGS_SELECT)
          .eq("inventory_items.user_id", userId).order("id").range(from, to)
      );
    case "Sales":
      return pageAll((from, to) =>
        supabaseAdmin.from("sales").select(SALES_SELECT)
          .eq("inventory_items.user_id", userId).order("id").range(from, to)
      );
    case "Sources":
      return pageAll((from, to) =>
        supabaseAdmin.from("sources").select(SOURCES_SELECT)
          .eq("user_id", userId).order("id").range(from, to)
      );
    default:
      return Promise.resolve([]);
  }
}

/** A1 range covering header + all data rows of a tab. */
function tabRange(tab: TabDef): string {
  return `'${tab.title}'!A1:${columnLetter(tab.columns.length)}`;
}

interface SheetRowEntry {
  /** 1-based sheet row number (header is row 1, data starts at 2). */
  rowNumber: number;
  cells: unknown[];
}

function indexSheetRows(rows: unknown[][]): Map<string, SheetRowEntry> {
  const map = new Map<string, SheetRowEntry>();
  rows.forEach((cells, i) => {
    const id = String(cells[0] ?? "").trim();
    // Only UUID-keyed rows participate; anything the user typed below the data
    // without an id is left alone.
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      map.set(id, { rowNumber: i + 2, cells });
    }
  });
  return map;
}

// ── Conflict-tab acceptance (the "Accept Sheet" action) ───────────────
interface ConflictAcceptance {
  rowNumber: number;
  flipdeskId: string;
  col: ColumnDef;
  value: string | number | null;
}

function parseConflictAcceptances(
  rows: unknown[][],
  errors: string[],
): ConflictAcceptance[] {
  const out: ConflictAcceptance[] = [];
  rows.forEach((cells, i) => {
    const status = String(cells[8] ?? "").trim();
    const action = String(cells[7] ?? "").trim();
    if (status !== CONFLICT_STATUS_OPEN || action !== CONFLICT_ACTION_ACCEPT_SHEET) return;
    const flipdeskId = String(cells[2] ?? "").trim();
    const fieldHeader = String(cells[4] ?? "").trim();
    const col = INVENTORY_COLUMNS.find((c) => c.header === fieldHeader && c.writable);
    if (!col || !/^[0-9a-f-]{36}$/i.test(flipdeskId)) {
      errors.push(`Conflicts row ${i + 2}: unknown field or id — skipped`);
      return;
    }
    const parsed = parsePulledValue(col, normalizeCell(cells[6], col.kind));
    if (!parsed.ok) {
      errors.push(`Conflicts row ${i + 2}: ${parsed.error}`);
      return;
    }
    out.push({ rowNumber: i + 2, flipdeskId, col, value: parsed.value });
  });
  return out;
}

// ── The per-user sync run ─────────────────────────────────────────────
export async function syncUserSheet(
  userId: string,
  trigger: string,
): Promise<RunSummary> {
  const summary: RunSummary = {
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: [],
    skippedItems: [],
  };

  // Per-user lease so the 5-min scheduler and a manual "Sync now" can't merge
  // the same sheet concurrently and double-apply pulls. Both the scheduled path
  // (handleSyncJob) and /sync/now call syncUserSheet, so this single per-user
  // lock already serializes them (US-1456 AC2).
  //
  // US-1456: the lease MUST exceed the worst-case merge duration AND the 5-min
  // scheduler cadence — a 240s lease could expire mid-run on a large sheet, letting
  // the next scheduler tick (or a /sync/now) start a concurrent merge that
  // re-reads edits, double-appends Conflicts rows, and races snapshot writes. 900s
  // (15 min) comfortably clears both. On normal completion the finally-block
  // releases the lock immediately; the TTL only bounds a crashed/hung run. (The
  // snapshot + cross-source-observation writes are already idempotent upserts, so
  // with concurrency prevented the double-append window is closed.)
  const lock = await acquireJobLock(`gsheet-sync:${userId}`, 900);
  if (!lock.acquired) {
    return { ...summary, skipped: lock.reason ?? "locked" };
  }
  try {
    const { data: connRow, error: connErr } = await supabaseAdmin
      .from("google_connections")
      .select("sheet_id, is_active")
      .eq("user_id", userId)
      .maybeSingle();
    // US-1481: a transient DB read failure must NOT be masked as no_sheet (which
    // surfaces to the user as "Connect Google…"). Surface it as a real error so
    // the run is reported as failed and retried, not silently skipped.
    if (connErr) {
      summary.errors.push(`Failed to load Google connection: ${connErr.message}`);
      return summary;
    }
    const conn = connRow as { sheet_id: string | null; is_active: boolean } | null;
    if (!conn?.is_active || !conn.sheet_id) {
      return { ...summary, skipped: "no_sheet" };
    }

    await supabaseAdmin
      .from("google_connections")
      .update({ sync_status: "syncing" })
      .eq("user_id", userId);

    try {
      await runMerge(userId, conn.sheet_id, trigger, summary);
      await supabaseAdmin
        .from("google_connections")
        .update({
          last_sync_at: new Date().toISOString(),
          sync_status: summary.errors.length ? "error" : "idle",
          sync_error: summary.errors[0] ?? null,
        })
        .eq("user_id", userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(msg);
      console.error("[gsheet-sync] run failed for user", userId, msg);
      await supabaseAdmin
        .from("google_connections")
        .update({ sync_status: "error", sync_error: msg.slice(0, 500) })
        .eq("user_id", userId);
    }
    return summary;
  } finally {
    await lock.release();
  }
}

async function runMerge(
  userId: string,
  sheetId: string,
  trigger: string,
  summary: RunSummary,
): Promise<void> {
  const token = await getGoogleAccessToken(userId);
  const api = new SheetsClient(token, sheetId);

  // 1. Ensure every tab exists.
  const tabs = await api.getTabs();
  const tabIds = new Map(tabs.map((t) => [t.title, t.sheetId]));
  const missing = ALL_TAB_TITLES.filter((t) => !tabIds.has(t));
  if (missing.length) {
    const res = await api.batchUpdateSpreadsheet(
      missing.map((title) => ({
        addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } },
      })),
    );
    for (const reply of res.replies ?? []) {
      const props = (reply as {
        addSheet?: { properties?: { sheetId?: number; title?: string } };
      }).addSheet?.properties;
      if (props && typeof props.sheetId === "number" && props.title) {
        tabIds.set(props.title, props.sheetId);
      }
    }
  }

  // 2. Read everything in one batch: header + data of each tab.
  const dataRanges = DATA_TABS.map(tabRange);
  const conflictsRange = `'${CONFLICTS_TAB}'!A1:${columnLetter(CONFLICTS_HEADERS.length - 1)}`;
  const syncLogRange = `'${SYNC_LOG_TAB}'!A1:F1`;
  const valuesByRange = await api.batchGetValues([
    ...dataRanges,
    conflictsRange,
    syncLogRange,
  ]);

  // 3. Tabs whose header row isn't ours yet (brand-new, or the bare
  // "Inventory" tab US-146's create endpoint made) get full structure setup:
  // headers, frozen first row, hidden id column, enum validation, gray
  // read-only fill.
  const setupRequests: Record<string, unknown>[] = [];
  const headerOf = (range: string) =>
    String(valuesByRange.get(range)?.[0]?.[0] ?? "");
  DATA_TABS.forEach((tab, i) => {
    if (headerOf(dataRanges[i]!) !== ID_HEADER) {
      setupRequests.push(...buildTabSetupRequests(tabIds.get(tab.title)!, tab.title));
    }
  });
  if (headerOf(conflictsRange) !== CONFLICTS_HEADERS[0]) {
    setupRequests.push(...buildTabSetupRequests(tabIds.get(CONFLICTS_TAB)!, CONFLICTS_TAB));
  }
  if (headerOf(syncLogRange) !== "Timestamp") {
    setupRequests.push(...buildTabSetupRequests(tabIds.get(SYNC_LOG_TAB)!, SYNC_LOG_TAB));
  }
  if (setupRequests.length) await api.batchUpdateSpreadsheet(setupRequests);

  // 4. Apply pending "Accept Sheet" conflict resolutions BEFORE the merge so
  // the accepted value lands in the DB and flows back to the Inventory tab in
  // the same run.
  const cellUpdates: { range: string; values: (string | number)[][] }[] = [];
  const conflictRows = (valuesByRange.get(conflictsRange) ?? []).slice(1);
  const acceptances = parseConflictAcceptances(conflictRows, summary.errors);
  const acceptedByRow = new Map<string, Record<string, string>>();
  for (const acc of acceptances) {
    const { error } = await supabaseAdmin
      .from("inventory_items")
      .update({ [acc.col.field]: acc.value })
      .eq("id", acc.flipdeskId)
      .eq("user_id", userId); // tenant scope (US-268)
    if (error) {
      summary.errors.push(`Accept Sheet failed for ${acc.col.header}: ${error.message}`);
      continue;
    }
    summary.pulled++;
    const statusCol = columnLetter(CONFLICTS_HEADERS.length - 1);
    cellUpdates.push({
      range: `'${CONFLICTS_TAB}'!${statusCol}${acc.rowNumber}`,
      values: [[CONFLICT_STATUS_APPLIED]],
    });
    const prev = acceptedByRow.get(acc.flipdeskId) ?? {};
    prev[acc.col.field] = normalizeCell(acc.value, acc.col.kind);
    acceptedByRow.set(acc.flipdeskId, prev);
  }

  // 5. Load snapshots (base values from the last run) for the writable tab.
  const snapshotRows = await pageAll((from, to) =>
    supabaseAdmin.from("google_sheet_sync_state")
      .select("flipdesk_id, snapshot")
      .eq("user_id", userId).eq("tab", "Inventory")
      .order("flipdesk_id").range(from, to)
  );
  const snapshots = new Map<string, Record<string, string>>(
    snapshotRows.map((r) => [
      String(r.flipdesk_id),
      (r.snapshot ?? {}) as Record<string, string>,
    ]),
  );

  // 6. Merge each tab.
  const snapshotUpserts: Row[] = [];
  const conflictAppends: (string | number)[][] = [];
  // US-148: what the sheet currently says about each listing's price/status/
  // title — recorded as cross-source observations after the merge. Listings
  // with an open conflict also report AGREEING values, so a sheet edited back
  // to FlipDesk's original value auto-converges its conflict.
  const sheetsObservations: SourceObservation[] = [];
  const { data: openConfRows } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select("listing_id")
    .eq("user_id", userId)
    .is("resolved_at", null);
  const openConflictListings = new Set(
    ((openConfRows ?? []) as { listing_id: string }[]).map((r) => r.listing_id),
  );
  const nowIso = new Date().toISOString();

  for (let t = 0; t < DATA_TABS.length; t++) {
    const tab = DATA_TABS[t]!;
    const sheetRows = indexSheetRows(
      (valuesByRange.get(dataRanges[t]!) ?? []).slice(1),
    );
    const records = await loadTabRecords(tab.title, userId);
    const appends: (string | number)[][] = [];
    const endCol = columnLetter(tab.columns.length);

    for (const record of records) {
      // Fold freshly-accepted conflict values into the in-memory record so the
      // serialized row reflects this run's DB state.
      const accepted = tab.title === "Inventory"
        ? acceptedByRow.get(String(record.id))
        : undefined;
      if (accepted) Object.assign(record, accepted);

      const dbRow = recordToRow(record, tab.columns);
      const id = dbRow[0]!;
      const entry = sheetRows.get(id);

      if (!entry) {
        appends.push(dbRow);
        if (tab.writable) {
          const seed: Record<string, string> = {};
          tab.columns.forEach((col, i) => {
            if (col.writable) seed[col.field] = dbRow[i + 1]!;
          });
          snapshotUpserts.push({
            user_id: userId,
            tab: tab.title,
            flipdesk_id: id,
            snapshot: seed,
          });
        }
        continue;
      }

      if (!tab.writable) {
        // Read-only tab: the DB is authoritative; rewrite the row on any drift.
        //
        // US-1083: on the Listings tab, eBay-owned fields on an eBay-originated
        // (locked) listing are NEVER pulled — eBay is source of truth. Such a
        // sheet edit is discarded (rewritten from the DB) and reported as a
        // skipped item. The skip is field-scoped: GradeThread-owned/unowned
        // cells on the same listing still sync.
        //
        // US-148: on a GradeThread-originated listing a hand-edited
        // price/status/title cell is instead a cross-source observation —
        // record it and HOLD the cell so the divergent value survives until the
        // user reconciles it. (Provenance replaced the retired
        // listings.source_of_truth pin — US-1078; this module no longer reads it.)
        const origin = tab.title === "Listings"
          ? deriveListingOrigin({
            platform: record.platform as string | null,
            platform_listing_id: record.platform_listing_id as string | null,
            batch_id: record.batch_id as string | null,
            synced_to_ebay_at: record.synced_to_ebay_at as string | null,
          })
          : "gradethread";
        const finalRow = [...dbRow];
        tab.columns.forEach((col, i) => {
          const sheetVal = normalizeCell(entry.cells[i + 1], col.kind);
          const dbVal = dbRow[i + 1]!;

          // Locked eBay-owned cell on an eBay-originated listing: do not apply.
          if (
            tab.title === "Listings" &&
            isSheetEditLockedByEbay(origin, col.field, sheetVal, dbVal)
          ) {
            const item = String(record.listing_title ?? id);
            summary.skippedItems.push({
              tab: tab.title,
              flipdesk_id: id,
              item,
              field: col.header,
              reason: SKIP_REASON_EBAY_LOCKED,
            });
            // Surface it on the (existing) Conflicts tab so the user sees what
            // was not synced and why. Never re-processed (status ≠ Open).
            conflictAppends.push([
              nowIso,
              tab.title,
              id,
              item,
              col.header,
              dbVal,
              sheetVal,
              CONFLICT_ACTION_LOCKED,
              CONFLICT_STATUS_SKIPPED,
            ]);
            return; // eBay wins — finalRow already carries the DB value.
          }

          const field =
            tab.title === "Listings" ? LISTING_CONFLICT_FIELDS[col.field] : undefined;
          if (sheetVal === dbVal) {
            // Agreement is only worth reporting when a conflict is open —
            // it lets the conflict auto-converge.
            if (field && sheetVal !== "" && openConflictListings.has(id)) {
              sheetsObservations.push({
                listingId: id,
                field,
                flipdeskValue: dbVal,
                observedValue: sheetVal,
              });
            }
            return;
          }
          // An emptied cell isn't a usable observation — just rewrite it.
          if (!field || sheetVal === "") return;
          sheetsObservations.push({
            listingId: id,
            field,
            flipdeskValue: dbVal,
            observedValue: sheetVal,
          });
          finalRow[i + 1] = sheetVal;
        });
        const needsWrite = tab.columns.some(
          (col, i) => normalizeCell(entry.cells[i + 1], col.kind) !== finalRow[i + 1],
        );
        if (needsWrite) {
          cellUpdates.push({
            range: `'${tab.title}'!A${entry.rowNumber}:${endCol}${entry.rowNumber}`,
            values: [finalRow as (string | number)[]],
          });
          summary.pushed++;
        }
        continue;
      }

      // Writable tab: 3-way field merge against the snapshot.
      const sheetRow = [
        id,
        ...tab.columns.map((col, i) => normalizeCell(entry.cells[i + 1], col.kind)),
      ];
      const prevSnapshot = snapshots.get(id);
      const merge = mergeRow(tab.columns, sheetRow, dbRow, prevSnapshot);
      let needsPush = merge.needsPush;

      // Validate + apply pulls (allow-listed fields only — enforced by the
      // column defs: only `writable` columns ever reach mergeRow's pulls).
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(merge.pulls)) {
        const col = tab.columns.find((c) => c.field === field)!;
        const parsed = parsePulledValue(col, value);
        if (!parsed.ok) {
          summary.errors.push(`${tab.title} "${record.title ?? id}": ${parsed.error}`);
          // Revert the invalid sheet edit to the FlipDesk value.
          merge.nextSnapshot[field] = dbRow[tab.columns.indexOf(col) + 1]!;
          delete merge.pulls[field];
          needsPush = true;
          continue;
        }
        patch[field] = parsed.value;
      }
      if (Object.keys(patch).length) {
        const { error } = await supabaseAdmin
          .from("inventory_items")
          .update(patch)
          .eq("id", id)
          .eq("user_id", userId); // tenant scope (US-268)
        if (error) {
          summary.errors.push(`Pull failed for "${record.title ?? id}": ${error.message}`);
          for (const field of Object.keys(patch)) {
            merge.nextSnapshot[field] = dbRow[tab.columns.indexOf(
              tab.columns.find((c) => c.field === field)!,
            ) + 1]!;
            delete merge.pulls[field];
          }
          needsPush = true;
        } else {
          summary.pulled++;
        }
      }

      // Conflicts: FlipDesk already won in nextSnapshot; flag for the user.
      for (const cf of merge.conflicts) {
        conflictAppends.push([
          nowIso,
          tab.title,
          id,
          String(record.title ?? record.sku ?? ""),
          cf.header,
          cf.dbValue,
          cf.sheetValue,
          CONFLICT_ACTION_KEEP,
          CONFLICT_STATUS_OPEN,
        ]);
        summary.conflicts++;
      }

      if (needsPush) {
        // Final row: DB values, except cells we just pulled keep the sheet's
        // (now also the DB's) value.
        const finalRow = [
          id,
          ...tab.columns.map((col, i) => merge.pulls[col.field] ?? dbRow[i + 1]!),
        ];
        cellUpdates.push({
          range: `'${tab.title}'!A${entry.rowNumber}:${endCol}${entry.rowNumber}`,
          values: [finalRow],
        });
        summary.pushed++;
      }

      const nextSnap = merge.nextSnapshot;
      if (JSON.stringify(prevSnapshot ?? null) !== JSON.stringify(nextSnap)) {
        snapshotUpserts.push({
          user_id: userId,
          tab: tab.title,
          flipdesk_id: id,
          snapshot: nextSnap,
        });
      }
    }

    for (const batch of chunk(appends, APPEND_CHUNK)) {
      await api.appendValues(tab.title, batch);
    }
    summary.pushed += appends.length;
  }

  // 7. Write cell updates (chunked to stay friendly to the quota), conflicts,
  // snapshots, and the Sync Log row.
  for (const batch of chunk(cellUpdates, VALUE_WRITE_CHUNK)) {
    await api.batchUpdateValues(batch);
  }
  for (const batch of chunk(conflictAppends, APPEND_CHUNK)) {
    await api.appendValues(CONFLICTS_TAB, batch);
  }
  for (const batch of chunk(snapshotUpserts, 500)) {
    const { error } = await supabaseAdmin
      .from("google_sheet_sync_state")
      .upsert(batch, { onConflict: "user_id,tab,flipdesk_id" });
    if (error) summary.errors.push(`Snapshot save failed: ${error.message}`);
  }

  // US-148: persist the sheet-vs-FlipDesk disagreements as cross-source
  // conflicts (one open row per listing+field; auto-converges if the sheet
  // returns to FlipDesk's original value).
  if (sheetsObservations.length > 0) {
    const res = await recordSourceObservations(userId, "sheets", sheetsObservations);
    summary.errors.push(...res.errors.map((e) => `cross-source: ${e.slice(0, 160)}`));
  }

  summary.errors = summary.errors.slice(0, MAX_LOGGED_ERRORS);
  // US-1083: note any locked eBay-owned cells we skipped in the run log so the
  // count is visible alongside errors/conflicts (detail lives on the Conflicts
  // tab and in the /sync/now response).
  const logNote = [
    summary.skippedItems.length
      ? `${summary.skippedItems.length} skipped (${SKIP_REASON_EBAY_LOCKED})`
      : "",
    summary.errors.join(" | "),
  ].filter(Boolean).join(" | ").slice(0, 2000);
  await api.appendValues(SYNC_LOG_TAB, [[
    nowIso,
    trigger,
    summary.pushed,
    summary.pulled,
    summary.conflicts,
    logNote,
  ]]);
}

// ── Scheduled jobs (internal auth) ────────────────────────────────────
// Both directions run the same full merge (see module comment), so one
// scheduled task on either path covers the 5-minute cadence.
async function handleSyncJob(c: Context, trigger: string): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isGoogleSheetsConfigured()) {
    return c.json({ error: "Google Sheets sync is not configured on this server." }, 503);
  }

  // Optional single-user target (testing / support).
  let targetUserId: string | null = null;
  try {
    const body = await c.req.json();
    if (typeof body?.user_id === "string" && /^[0-9a-f-]{36}$/i.test(body.user_id)) {
      targetUserId = body.user_id;
    }
  } catch {
    /* empty body is the normal scheduler case */
  }

  const lock = await acquireJobLock("google-sheet-sync", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    let query = supabaseAdmin
      .from("google_connections")
      .select("user_id")
      .eq("is_active", true)
      .not("sheet_id", "is", null);
    if (targetUserId) query = query.eq("user_id", targetUserId);
    const { data, error } = await query;
    if (error) return c.json({ error: error.message }, 500);

    let synced = 0;
    let failed = 0;
    let conflicts = 0;
    let skipped = 0;
    for (const row of (data ?? []) as { user_id: string }[]) {
      try {
        const s = await syncUserSheet(row.user_id, trigger);
        if (!s.skipped) synced++;
        conflicts += s.conflicts;
        skipped += s.skippedItems.length;
        if (s.errors.length) failed++;
      } catch (err) {
        failed++;
        console.error(
          "[gsheet-sync] user sync threw",
          row.user_id,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return c.json({
      ok: true,
      users_synced: synced,
      users_failed: failed,
      conflicts,
      skipped,
    });
  } finally {
    await lock.release();
  }
}

flipdeskGoogleSyncRoutes.post("/sync/push", (c) => handleSyncJob(c, "scheduled-push"));
flipdeskGoogleSyncRoutes.post("/sync/pull", (c) => handleSyncJob(c, "scheduled-pull"));

// ── POST /sync/now — the manual "Sync now" button ─────────────────────
flipdeskGoogleSyncRoutes.post("/sync/now", async (c) => {
  if (!isGoogleSheetsConfigured()) {
    return c.json({ error: "Google Sheets sync is not configured on this server." }, 503);
  }
  const role = c.get("workspaceRole");
  if (role === "viewer") {
    return c.json({ error: "Viewers can't trigger a sync." }, 403);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const summary = await syncUserSheet(userId, "manual");
    if (summary.skipped === "no_sheet") {
      return c.json({ error: "Connect Google and pick a sync sheet first." }, 409);
    }
    if (summary.skipped) {
      return c.json({ ok: true, skipped: true, reason: summary.skipped });
    }
    // US-1481: the run can finish with per-row/connection errors collected in
    // summary.errors. Don't report that as a clean success — surface a non-2xx
    // with the error so the UI shows it instead of a "Synced" toast.
    if (summary.errors.length) {
      const error = summary.errors[0] ?? "Sync completed with errors.";
      return c.json({ ok: false, error, ...summary }, 502);
    }
    return c.json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed.";
    return c.json({ error: msg }, 502);
  }
});
