// Offline intake queue for FlipDesk (US-134). When a reseller catalogs items
// without a connection, the intake payloads are persisted to IndexedDB and
// flushed to Supabase once the device comes back online.
import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";
import { PhotoPrepError, uploadItemPhoto } from "@/lib/item-photo-upload";
import { isOffline } from "@/lib/friendly-error";
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
    photos: (extras.photos ?? []).map((p) => ({
      ...p,
      id: p.id ?? crypto.randomUUID(),
    })),
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

// Pushes every queued intake to Supabase, removing each once its item row and
// photos are all up. A record whose item failed stays queued and counts as
// failed; a record whose item saved but whose photos did not stays queued for
// the photos only and counts as synced, with the photos in photosPending.
export async function flushIntakeQueue(
  onProgress?: (done: number, total: number) => void,
): Promise<FlushResult> {
  const queued = await getQueuedIntakes();
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
    captureException(err, {
      tags: { area },
      extra: { queueRecordId: record.id },
    });
  };
  for (let i = 0; i < queued.length; i++) {
    let record = queued[i]!;
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
        onProgress?.(i + 1, queued.length);
        continue;
      }
      if (!alreadySaved) synced++;
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
    onProgress?.(i + 1, queued.length);
  }
  return {
    synced,
    failed,
    firstError,
    photosDropped,
    photosPending,
    firstPhotoError,
    photosUnprocessable,
    firstUnprocessableError,
  };
}
