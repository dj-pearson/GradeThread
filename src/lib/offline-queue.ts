// Offline intake queue for FlipDesk (US-134). When a reseller catalogs items
// without a connection, the intake payloads are persisted to IndexedDB and
// flushed to Supabase once the device comes back online.
import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";
import { uploadItemPhoto } from "@/lib/item-photo-upload";
import type { FlipdeskPhotoType, InventoryItemInsert } from "@/types/database";

const DB_NAME = "flipdesk-offline";
const DB_VERSION = 1;
const STORE = "intake-queue";

// A staged intake photo held as bytes. IndexedDB stores Blobs natively, so a
// photo taken with no signal is not lost when the form resets.
export interface QueuedIntakePhoto {
  blob: Blob;
  name: string;
  photoType: FlipdeskPhotoType;
  photoRole: string | null;
  sortOrder: number;
}

export interface QueuedIntake {
  id: string;
  createdAt: number;
  payload: InventoryItemInsert;
  /**
   * A source typed in while offline. Creating it is a server RPC, so the name
   * rides with the item and get_or_create_source runs at flush time.
   */
  newSourceName?: string | null;
  /** Photos still to upload once the item row exists. */
  photos?: QueuedIntakePhoto[];
  /** Flushes that inserted the item but left photos behind. */
  photoAttempts?: number;
}

// After this many flushes that could not upload a photo, the photo is dropped
// and the seller is told to add it from the item page. Without a cap, one
// photo the server refuses every time keeps the item queued forever.
export const MAX_PHOTO_ATTEMPTS = 5;

export interface FlushResult {
  synced: number;
  failed: number;
  /**
   * US-2364: why the first failure failed. A queue that retries forever without
   * ever reporting a reason cannot be told apart from a queue that is simply
   * offline — and those two need opposite responses.
   */
  firstError: string | null;
  /** Photos given up on after MAX_PHOTO_ATTEMPTS; the item itself synced. */
  photosDropped: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Could not open the offline database."));
  });
}

async function runTx<T>(
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = build(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function enqueueIntake(
  payload: InventoryItemInsert,
  extras: {
    newSourceName?: string | null;
    photos?: QueuedIntakePhoto[];
  } = {},
): Promise<void> {
  const record: QueuedIntake = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    payload,
    newSourceName: extras.newSourceName ?? null,
    photos: extras.photos ?? [],
  };
  await runTx("readwrite", (s) => s.add(record));
}

async function putQueuedIntake(record: QueuedIntake): Promise<void> {
  await runTx("readwrite", (s) => s.put(record));
}

async function getQueuedIntakes(): Promise<QueuedIntake[]> {
  const all = await runTx<QueuedIntake[]>(
    "readonly",
    (s) => s.getAll() as IDBRequest<QueuedIntake[]>,
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

async function removeQueuedIntake(id: string): Promise<void> {
  await runTx("readwrite", (s) => s.delete(id));
}

export async function queuedIntakeCount(): Promise<number> {
  return await runTx<number>("readonly", (s) => s.count());
}

// Pushes every queued intake to Supabase, removing each on success. Failed
// rows stay queued for the next attempt.
export async function flushIntakeQueue(
  onProgress?: (done: number, total: number) => void,
): Promise<FlushResult> {
  const queued = await getQueuedIntakes();
  let synced = 0;
  let failed = 0;
  let photosDropped = 0;
  let firstError: string | null = null;
  for (let i = 0; i < queued.length; i++) {
    const record = queued[i]!;
    try {
      let payload: InventoryItemInsert = record.payload;
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
      const row = { ...payload, id: record.id } as never;
      const { error } = await supabase
        .from("inventory_items")
        .upsert(row, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;

      // The item exists now. Upload its photos; any that fail stay on the
      // record (with the source already resolved) and are retried next flush.
      const left: QueuedIntakePhoto[] = [];
      let photoError: unknown = null;
      for (const photo of record.photos ?? []) {
        try {
          await uploadItemPhoto({
            file: new File([photo.blob], photo.name, { type: photo.blob.type }),
            itemId: record.id,
            ownerFolder: payload.user_id,
            photoType: photo.photoType,
            photoRole: photo.photoRole,
            sortOrder: photo.sortOrder,
          });
        } catch (err) {
          left.push(photo);
          photoError ??= err;
        }
      }
      const attempts = (record.photoAttempts ?? 0) + 1;
      if (left.length > 0 && attempts < MAX_PHOTO_ATTEMPTS) {
        await putQueuedIntake({
          ...record,
          payload,
          newSourceName: null,
          photos: left,
          photoAttempts: attempts,
        });
        throw photoError instanceof Error
          ? photoError
          : new Error(`${left.length} photo(s) did not upload yet.`);
      }
      photosDropped += left.length;
      await removeQueuedIntake(record.id);
      synced++;
    } catch (err) {
      // US-2364: keep the reason. Discarding it made the two failure modes
      // indistinguishable, and they need opposite responses: a lost connection
      // SHOULD retry forever, while an RLS refusal or a schema mismatch will
      // fail identically on every future flush — a row that can never sync,
      // retried silently, for as long as the browser profile lives. The queue
      // still retries (that part was right); what it no longer does is retry
      // without ever saying why.
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (!firstError) firstError = message;
      captureException(err, {
        tags: { area: "offline-intake-flush" },
        extra: { queueRecordId: record.id },
      });
    }
    onProgress?.(i + 1, queued.length);
  }
  return { synced, failed, firstError, photosDropped };
}
