// Offline intake queue for FlipDesk (US-134). When a reseller catalogs items
// without a connection, the intake payloads are persisted to IndexedDB and
// flushed to Supabase once the device comes back online.
import { supabase } from "@/lib/supabase";
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

export async function getQueuedIntakes(): Promise<QueuedIntake[]> {
  const all = await runTx<QueuedIntake[]>(
    "readonly",
    (s) => s.getAll() as IDBRequest<QueuedIntake[]>,
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeQueuedIntake(id: string): Promise<void> {
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
  for (let i = 0; i < queued.length; i++) {
    const record = queued[i]!;
    try {
      const { error } = await supabase
        .from("inventory_items")
        .insert(record.payload as never);
      if (error) throw error;
      await removeQueuedIntake(record.id);
      synced++;
    } catch {
      failed++;
    }
    onProgress?.(i + 1, queued.length);
  }
  return { synced, failed };
}
