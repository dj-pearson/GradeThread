// Offline intake queue for FlipDesk (US-134). When a reseller catalogs items
// without a connection, the intake payloads are persisted to IndexedDB and
// flushed to Supabase once the device comes back online.
import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";
import { PhotoPrepError, uploadItemPhoto } from "@/lib/item-photo-upload";
import { isOffline } from "@/lib/friendly-error";
import type { FlipdeskPhotoType, InventoryItemInsert } from "@/types/database";

const DB_NAME = "flipdesk-offline";
// v2: records carry queuedBy, indexed, so one seller's queue is invisible to
// the next account signed in on the same device.
const DB_VERSION = 2;
const STORE = "intake-queue";
const BY_USER = "queuedBy";
// [queuedBy, createdAt]: one user's records, oldest first, as keys only, so a
// flush never loads every queued photo into memory at once.
const BY_USER_CREATED = "queuedBy_createdAt";
const FLUSH_LOCK = "flipdesk-offline-flush";

// A staged intake photo held as bytes. IndexedDB stores Blobs natively, so a
// photo taken with no signal is not lost when the form resets.
export interface QueuedIntakePhoto {
  blob: Blob;
  name: string;
  photoType: FlipdeskPhotoType;
  photoRole: string | null;
  sortOrder: number;
  /**
   * Fixed for the life of the queued photo and passed to uploadItemPhoto as
   * its photoId, so every retry targets the same storage path and row id. A
   * retry after a lost response then finds its own upload instead of making a
   * duplicate. Records queued before this field existed get one at flush time.
   */
  id?: string;
  /** Uploads of THIS photo that reached the server and failed. */
  attempts?: number;
}

export interface QueuedIntake {
  id: string;
  createdAt: number;
  /**
   * The signed-in auth user who queued this record. Count and flush only ever
   * touch the current user's records. A record without one (queued before v2)
   * is held: never counted, never flushed, and deleted with the database at
   * sign-out.
   */
  queuedBy?: string;
  payload: InventoryItemInsert;
  /**
   * A source typed in while offline. Creating it is a server RPC, so the name
   * rides with the item and get_or_create_source runs at flush time.
   */
  newSourceName?: string | null;
  /** Photos still to upload once the item row exists. */
  photos?: QueuedIntakePhoto[];
  /**
   * The item row is on the server; only photos are left. Such a record is not
   * counted as synced again when its photos finish, and never as failed.
   */
  itemSaved?: boolean;
}

// After this many uploads of one photo that reached the server and failed, the
// photo is dropped and the seller is told to add it from the item page.
// Without a cap, one photo the server refuses every time stays queued forever.
// A try that never reached the server (offline, fetch rejected) does not
// count: a dead zone is not a verdict on the photo. Neither does a photo this
// device cannot convert or re-encode (PhotoPrepError): nothing was sent, and
// the same bytes fail the same way every time, so it is set aside at once as
// unprocessable, with the reason, instead of spending five flushes on it.
export const MAX_PHOTO_ATTEMPTS = 5;

export interface FlushResult {
  synced: number;
  /** Item ids inserted by this flush, for a "Review N items" link. */
  syncedIds: string[];
  failed: number;
  /**
   * US-2364: why the first failure failed. A queue that retries forever without
   * ever reporting a reason cannot be told apart from a queue that is simply
   * offline — and those two need opposite responses.
   */
  firstError: string | null;
  /** Photos given up on after MAX_PHOTO_ATTEMPTS; the item itself synced. */
  photosDropped: number;
  /**
   * Photos of SAVED items still waiting to upload. Their items are counted in
   * `synced`, not `failed`: the item exists and only the photos will retry.
   */
  photosPending: number;
  /** Why the first photo upload failed, kept apart from item failures. */
  firstPhotoError: string | null;
  /**
   * Photos set aside because this device could not prepare them for upload
   * (HEIC or video conversion, or the re-encode, failed). Not in photosDropped:
   * they never reached the server and the fix is a different photo.
   */
  photosUnprocessable: number;
  /** The seller-facing reason the first unprocessable photo was set aside. */
  firstUnprocessableError: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "id" });
      if (!store.indexNames.contains(BY_USER)) store.createIndex(BY_USER, BY_USER);
      if (!store.indexNames.contains(BY_USER_CREATED)) {
        store.createIndex(BY_USER_CREATED, [BY_USER, "createdAt"]);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Sign-out deletes the database; never be the handle that blocks it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () =>
      reject(req.error ?? new Error("Could not open the offline database."));
  });
}

/** One request in its own transaction on an open handle. */
function onStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = build(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function runTx<T>(
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await onStore(db, mode, build);
  } finally {
    db.close();
  }
}

// Ask once for persistent storage when something is first queued, so the
// browser does not evict unsynced photos under storage pressure. Best-effort.
let persistAsked = false;
function askToPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    void storage?.persist?.().catch(() => undefined);
  } catch {
    /* not supported */
  }
}

export async function enqueueIntake(
  payload: InventoryItemInsert,
  extras: {
    /** The signed-in auth user id. Only they will see or flush this record. */
    queuedBy: string;
    /**
     * The form's draft id, which becomes the item id. Passed when an online
     * try may already have landed, so the replay finds that row instead of
     * making a second item.
     */
    id?: string;
    newSourceName?: string | null;
    photos?: QueuedIntakePhoto[];
  },
): Promise<void> {
  const record: QueuedIntake = {
    id: extras.id ?? crypto.randomUUID(),
    createdAt: Date.now(),
    queuedBy: extras.queuedBy,
    payload,
    newSourceName: extras.newSourceName ?? null,
    photos: (extras.photos ?? []).map((p) => ({
      ...p,
      id: p.id ?? crypto.randomUUID(),
    })),
  };
  await runTx("readwrite", (s) => s.add(record));
  askToPersist();
}

/**
 * Photos of an item that IS saved but whose uploads failed online. They wait
 * in the queue under the item's id and upload on the next flush, the same as
 * the photos of an item that was queued whole.
 */
export async function enqueuePhotosForItem(args: {
  itemId: string;
  ownerId: string;
  title: string;
  queuedBy: string;
  photos: QueuedIntakePhoto[];
}): Promise<void> {
  if (args.photos.length === 0) return;
  const record: QueuedIntake = {
    id: args.itemId,
    createdAt: Date.now(),
    queuedBy: args.queuedBy,
    payload: { user_id: args.ownerId, title: args.title },
    newSourceName: null,
    itemSaved: true,
    photos: args.photos.map((p) => ({ ...p, id: p.id ?? crypto.randomUUID() })),
  };
  await runTx("readwrite", (s) => s.put(record));
  askToPersist();
}

/** Records queued by this user. Nobody else's, and never an unowned one. */
export async function queuedIntakeCount(queuedBy: string): Promise<number> {
  return await runTx<number>("readonly", (s) => s.index(BY_USER).count(queuedBy));
}

export interface QueueCounts {
  /** Items whose row is not on the server yet. */
  itemsPending: number;
  /** Photos still to upload, for queued items and saved ones alike. */
  photosPending: number;
}

/** What this user has waiting, split the way the intake banner says it. */
export async function queueCounts(queuedBy: string): Promise<QueueCounts> {
  const mine = await runTx<QueuedIntake[]>(
    "readonly",
    (s) => s.index(BY_USER).getAll(queuedBy) as IDBRequest<QueuedIntake[]>,
  );
  let itemsPending = 0;
  let photosPending = 0;
  for (const r of mine) {
    if (!r.itemSaved) itemsPending++;
    photosPending += r.photos?.length ?? 0;
  }
  return { itemsPending, photosPending };
}

// Set while a flush runs in THIS tab. navigator.locks covers other tabs.
let flushingHere = false;

/**
 * Flush unless one is already running here or in another tab, in which case
 * it returns null and does nothing: two tabs flushing at once used to upload
 * the same photos twice.
 */
export async function flushIntakeQueueExclusive(
  queuedBy: string,
  onProgress?: (done: number, total: number) => void,
): Promise<FlushResult | null> {
  if (flushingHere) return null;
  flushingHere = true;
  try {
    const locks =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) {
      return await locks.request(FLUSH_LOCK, { ifAvailable: true }, async (lock) =>
        lock ? flushIntakeQueue(queuedBy, onProgress) : null,
      );
    }
    return await flushIntakeQueue(queuedBy, onProgress);
  } finally {
    flushingHere = false;
  }
}

/**
 * Delete the whole offline intake database. Called at sign-out, so a shared
 * tablet never keeps one seller's costs, notes and raw photos for the next
 * account. Best-effort and never throws; another tab holding the database
 * open blocks the delete until it closes, so sign-out does not wait on it.
 */
export function clearOfflineIntakeQueue(): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Pushes every queued intake to Supabase, removing each once its item row and
// photos are all up. A record whose item failed stays queued and counts as
// failed; a record whose item saved but whose photos did not stays queued for
// the photos only and counts as synced, with the photos in photosPending.
export async function flushIntakeQueue(
  queuedBy: string,
  onProgress?: (done: number, total: number) => void,
): Promise<FlushResult> {
  const db = await openDb();
  try {
    return await flushWith(db, queuedBy, onProgress);
  } finally {
    db.close();
  }
}

async function flushWith(
  db: IDBDatabase,
  queuedBy: string,
  onProgress?: (done: number, total: number) => void,
): Promise<FlushResult> {
  // Keys only, oldest first; each record is read when its turn comes.
  const keys = await onStore(db, "readonly", (s) =>
    s
      .index(BY_USER_CREATED)
      .getAllKeys(IDBKeyRange.bound([queuedBy, -Infinity], [queuedBy, Infinity])),
  );
  const putQueuedIntake = (r: QueuedIntake) => onStore(db, "readwrite", (s) => s.put(r));
  const removeQueuedIntake = (id: string) => onStore(db, "readwrite", (s) => s.delete(id));
  const syncedIds: string[] = [];
  let synced = 0;
  let failed = 0;
  let photosDropped = 0;
  let photosPending = 0;
  let firstError: string | null = null;
  let firstPhotoError: string | null = null;
  let photosUnprocessable = 0;
  let firstUnprocessableError: string | null = null;
  const report = (err: unknown, record: QueuedIntake, area: string) => {
    const message = err instanceof Error ? err.message : String(err);
    if (area === "offline-intake-photo") firstPhotoError ??= message;
    else firstError ??= message;
    // A dropped connection is the queue doing its job, not an error.
    if (isOffline(err)) return;
    captureException(err, {
      tags: { area },
      extra: { queueRecordId: record.id },
    });
  };
  for (let i = 0; i < keys.length; i++) {
    const stored = (await onStore(db, "readonly", (s) => s.get(keys[i]!))) as
      | QueuedIntake
      | undefined;
    // Gone (another flush finished it) or not this user's: leave it alone.
    if (!stored || stored.queuedBy !== queuedBy) {
      onProgress?.(i + 1, keys.length);
      continue;
    }
    let record = stored;
    let payload: InventoryItemInsert = record.payload;
    if (!record.itemSaved) {
      let alreadySaved = false;
      try {
        // A source created while offline. get_or_create_source is keyed on the
        // name, so a replay after a lost response finds the same row.
        if (record.newSourceName) {
          const rpc = supabase as unknown as {
            rpc: (
              fn: string,
              args: Record<string, unknown>,
            ) => Promise<{ data: string | null; error: Error | null }>;
          };
          const { data, error } = await rpc.rpc("get_or_create_source", {
            p_user_id: payload.user_id,
            p_name: record.newSourceName,
            p_source_type: "other",
          });
          if (error) throw error;
          payload = { ...payload, source_id: data };
        }
        // US-1634: idempotent replay. The old code did a plain insert with no
        // idempotency key, so a re-flush (the insert succeeded server-side but the
        // response was lost → catch → row stays queued) OR two tabs flushing at
        // once (the lock is per-tab) inserted the SAME intake twice — a duplicate
        // inventory item. Use the stable queue-record id as the item id and
        // upsert-ignore-duplicates so a replay is a no-op.
        //
        // The same id also answers "did an earlier flush already save this?".
        // If that flush inserted the row and then failed to record itemSaved
        // (IndexedDB refused the write), this replay's upsert hits the existing
        // row, ignoreDuplicates returns no rows, and the item is treated as
        // saved rather than counted as a second new item.
        const row = { ...payload, id: record.id } as never;
        const { data: insertedRows, error } = await supabase
          .from("inventory_items")
          .upsert(row, { onConflict: "id", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        alreadySaved = (insertedRows?.length ?? 0) === 0;
      } catch (err) {
        // US-2364: keep the reason. Discarding it made the two failure modes
        // indistinguishable, and they need opposite responses: a lost connection
        // SHOULD retry forever, while an RLS refusal or a schema mismatch will
        // fail identically on every future flush — a row that can never sync,
        // retried silently, for as long as the browser profile lives. The queue
        // still retries (that part was right); what it no longer does is retry
        // without ever saying why.
        failed++;
        report(err, record, "offline-intake-flush");
        onProgress?.(i + 1, keys.length);
        continue;
      }
      if (!alreadySaved) {
        synced++;
        syncedIds.push(record.id);
      }
    }

    try {
      // The item exists now. Give every photo its stable id BEFORE the first
      // upload, so a response lost mid-upload is retried under the same id.
      const photos = (record.photos ?? []).map((p) =>
        p.id ? p : { ...p, id: crypto.randomUUID() },
      );
      record = {
        ...record,
        payload,
        newSourceName: null,
        photos,
        itemSaved: true,
      };
      if (photos.length > 0) await putQueuedIntake(record);

      const left: QueuedIntakePhoto[] = [];
      for (const photo of photos) {
        // Connection gone: leave this and the rest for the next flush without
        // spending an attempt on any of them.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          left.push(photo);
          continue;
        }
        try {
          await uploadItemPhoto({
            file: new File([photo.blob], photo.name, { type: photo.blob.type }),
            itemId: record.id,
            ownerFolder: payload.user_id,
            photoType: photo.photoType,
            photoRole: photo.photoRole,
            sortOrder: photo.sortOrder,
            photoId: photo.id,
          });
        } catch (err) {
          if (err instanceof PhotoPrepError) {
            // Never left the device, and will not convert next time either.
            photosUnprocessable++;
            firstUnprocessableError ??= err.message;
            captureException(err, {
              tags: { area: "offline-intake-photo-prep" },
              extra: { queueRecordId: record.id },
            });
            continue;
          }
          report(err, record, "offline-intake-photo");
          const attempts = (photo.attempts ?? 0) + (isOffline(err) ? 0 : 1);
          if (attempts >= MAX_PHOTO_ATTEMPTS) photosDropped++;
          else left.push({ ...photo, attempts });
        }
      }
      if (left.length > 0) {
        await putQueuedIntake({ ...record, photos: left });
        photosPending += left.length;
      } else {
        await removeQueuedIntake(record.id);
      }
    } catch (err) {
      // IndexedDB refused the write. The item is saved; the record keeps
      // whatever it last stored and the photos retry next flush.
      report(err, record, "offline-intake-photo");
      photosPending += record.photos?.length ?? 0;
    }
    onProgress?.(i + 1, keys.length);
  }
  return {
    synced,
    syncedIds,
    failed,
    firstError,
    photosDropped,
    photosPending,
    firstPhotoError,
    photosUnprocessable,
    firstUnprocessableError,
  };
}
