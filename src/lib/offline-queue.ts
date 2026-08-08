// Offline intake queue for FlipDesk (US-134). When a reseller catalogs items
// without a connection, the intake payloads are persisted to IndexedDB and
// flushed to Supabase once the device comes back online.
import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";
import type { InventoryItemInsert } from "@/types/database";

const DB_NAME = "flipdesk-offline";
const DB_VERSION = 1;
const STORE = "intake-queue";

export interface QueuedIntake {
  id: string;
  createdAt: number;
  payload: InventoryItemInsert;
}

export interface FlushResult {
  synced: number;
  failed: number;
  /**
   * US-2364: why the first failure failed. A queue that retries forever without
   * ever reporting a reason cannot be told apart from a queue that is simply
   * offline — and those two need opposite responses.
   */
  firstError: string | null;
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

export async function enqueueIntake(payload: InventoryItemInsert): Promise<void> {
  const record: QueuedIntake = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    payload,
  };
  await runTx("readwrite", (s) => s.add(record));
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
  let firstError: string | null = null;
  for (let i = 0; i < queued.length; i++) {
    const record = queued[i]!;
    try {
      // US-1634: idempotent replay. The old code did a plain insert with no
      // idempotency key, so a re-flush (the insert succeeded server-side but the
      // response was lost → catch → row stays queued) OR two tabs flushing at
      // once (the lock is per-tab) inserted the SAME intake twice — a duplicate
      // inventory item. Use the stable queue-record id as the item id and
      // upsert-ignore-duplicates so a replay is a no-op.
      const payload = { ...record.payload, id: record.id } as never;
      const { error } = await supabase
        .from("inventory_items")
        .upsert(payload, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
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
  return { synced, failed, firstError };
}
