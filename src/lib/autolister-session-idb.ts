// US-1905: IndexedDB persistence for AutoLister sessions.
//
// localStorage overflows on 600-photo sessions (the size-guard drops photo-edit
// undo snapshots) and it cannot hold the original File blobs of queued uploads,
// so a reload loses queued work. This module keeps the whole session (staged
// metadata, groups, roles, sort prefs, undo snapshot) and the pending upload
// blobs in IndexedDB. Callers fall back to localStorage when IDB is unavailable
// (some private-browsing modes). Hand-rolled promise wrapper — no runtime dep.
//
// IndexedDB gotcha: a transaction auto-commits once it goes idle, so you cannot
// `await` an unrelated microtask between two requests of the SAME transaction.
// Every multi-request op below is issued synchronously inside one transaction
// and the result is resolved on the transaction's `complete` event.

const DB_NAME = "autolister";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const BLOB_STORE = "blobs";
const BY_SESSION_CREATED = "bySessionCreated";

export interface PersistedSession {
  staged: unknown[];
  groups: unknown[];
  /** Single-level undo snapshot of the group list (null when none). */
  undo?: unknown[] | null;
  /** Grid sort mode + "group every N" chunk size. */
  sort?: { ungroupedSort?: string; groupEvery?: number } | null;
  updatedAt: number;
}

interface SessionRow extends PersistedSession {
  sessionId: string;
}

export interface PersistedBlob {
  taskId: string;
  sessionId: string;
  sig: string;
  blob: Blob;
  createdAt: number;
}

/** True when IndexedDB is usable in this environment. */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        const store = db.createObjectStore(BLOB_STORE, { keyPath: "taskId" });
        // Ordered eviction: oldest-first within a session.
        store.createIndex(BY_SESSION_CREATED, ["sessionId", "createdAt"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Run `body` inside one transaction and resolve on `complete` (never mid-flight)
 * so multi-request ops are atomic and quota/abort errors surface reliably.
 */
function runTx<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, resolveWith: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let value: T;
    const transaction = db.transaction(stores, mode);
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("transaction aborted", "AbortError"));
    try {
      body(transaction, (v) => {
        value = v;
      });
    } catch (err) {
      try {
        transaction.abort();
      } catch {
        /* already aborting */
      }
      reject(err);
    }
  });
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "QuotaExceededError";
}

// ── Session state ────────────────────────────────────────────────────

export async function saveSession(sessionId: string, session: PersistedSession): Promise<void> {
  if (!idbAvailable()) return;
  const row: SessionRow = { sessionId, ...session };
  await withDb((db) =>
    runTx<void>(db, SESSION_STORE, "readwrite", (tx, done) => {
      tx.objectStore(SESSION_STORE).put(row);
      done(undefined);
    }),
  );
}

export async function loadSession(sessionId: string): Promise<PersistedSession | null> {
  if (!idbAvailable()) return null;
  return withDb((db) =>
    runTx<PersistedSession | null>(db, SESSION_STORE, "readonly", (tx, done) => {
      const req = tx.objectStore(SESSION_STORE).get(sessionId);
      req.onsuccess = () => {
        const row = req.result as SessionRow | undefined;
        if (!row) return done(null);
        const { sessionId: _drop, ...session } = row;
        void _drop;
        done(session);
      };
    }),
  );
}

/** Delete a session row and every blob that belongs to it. */
export async function clearSession(sessionId: string): Promise<void> {
  if (!idbAvailable()) return;
  await withDb((db) =>
    runTx<void>(db, [SESSION_STORE, BLOB_STORE], "readwrite", (tx, done) => {
      tx.objectStore(SESSION_STORE).delete(sessionId);
      const idx = tx.objectStore(BLOB_STORE).index(BY_SESSION_CREATED);
      const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
      const cursorReq = idx.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      done(undefined);
    }),
  );
}

/**
 * One-time migration: if IDB has no session yet but localStorage holds one,
 * copy it into IDB (metadata only — localStorage never held blobs). Returns the
 * migrated session, or the existing IDB session, or null.
 */
export async function migrateSessionFromLocalStorage(
  sessionId: string,
  rawLocalStorage: string | null,
): Promise<PersistedSession | null> {
  if (!idbAvailable()) return null;
  const existing = await loadSession(sessionId);
  if (existing) return existing;
  if (!rawLocalStorage) return null;
  let parsed: { staged?: unknown; groups?: unknown };
  try {
    parsed = JSON.parse(rawLocalStorage) as { staged?: unknown; groups?: unknown };
  } catch {
    return null;
  }
  const migrated: PersistedSession = {
    staged: Array.isArray(parsed.staged) ? parsed.staged : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    undo: null,
    sort: null,
    updatedAt: 0,
  };
  await saveSession(sessionId, migrated);
  return migrated;
}

// ── Upload blobs ─────────────────────────────────────────────────────

export async function listBlobs(sessionId: string): Promise<PersistedBlob[]> {
  if (!idbAvailable()) return [];
  return withDb((db) =>
    runTx<PersistedBlob[]>(db, BLOB_STORE, "readonly", (tx, done) => {
      const idx = tx.objectStore(BLOB_STORE).index(BY_SESSION_CREATED);
      const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
      const req = idx.getAll(range);
      req.onsuccess = () => done((req.result as PersistedBlob[]) ?? []);
    }),
  );
}

export async function deleteBlob(taskId: string): Promise<void> {
  if (!idbAvailable()) return;
  await withDb((db) =>
    runTx<void>(db, BLOB_STORE, "readwrite", (tx, done) => {
      tx.objectStore(BLOB_STORE).delete(taskId);
      done(undefined);
    }),
  );
}

/** Delete the `count` oldest blobs for a session (quota relief). Returns deleted. */
export async function evictOldestBlobs(sessionId: string, count: number): Promise<number> {
  if (!idbAvailable() || count <= 0) return 0;
  return withDb((db) =>
    runTx<number>(db, BLOB_STORE, "readwrite", (tx, done) => {
      const idx = tx.objectStore(BLOB_STORE).index(BY_SESSION_CREATED);
      const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
      const cursorReq = idx.openCursor(range); // ascending → oldest first
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < count) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          done(deleted);
        }
      };
    }),
  );
}

/**
 * Persist one queued upload's original blob. On QuotaExceededError, evict the
 * oldest blobs for this session and retry once; if it still fails, the caller
 * treats the upload as non-resumable (metadata is always kept regardless).
 */
export async function putBlob(entry: PersistedBlob): Promise<boolean> {
  if (!idbAvailable()) return false;
  const write = () =>
    withDb((db) =>
      runTx<void>(db, BLOB_STORE, "readwrite", (tx, done) => {
        tx.objectStore(BLOB_STORE).put(entry);
        done(undefined);
      }),
    );
  try {
    await write();
    return true;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await evictOldestBlobs(entry.sessionId, 10);
    try {
      await write();
      return true;
    } catch (retryErr) {
      if (isQuotaError(retryErr)) return false;
      throw retryErr;
    }
  }
}
