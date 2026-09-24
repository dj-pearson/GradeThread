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
  /**
   * AL-03: the workspace owner this session was staged for. A row stamped
   * with another owner (or none) is not trusted on load; see
   * scopeSessionToOwner.
   */
  ownerId?: string;
}

interface SessionRow extends PersistedSession {
  sessionId: string;
}

export interface PersistedBlob {
  taskId: string;
  sessionId: string;
  sig: string;
  /** Original filename + MIME type, so the resumed upload rebuilds an
   *  identical File even if structured clone degrades File → Blob. */
  name: string;
  type: string;
  /** The original File (a Blob subclass); structured-cloned into IDB. */
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
 * Append one staged photo to a session's `staged` array, atomically (get → put
 * in one transaction, deduped by id). Used by the upload store when the page is
 * unmounted: a photo that finishes while detached must land in IDB (the page's
 * authoritative store), not only localStorage. A no-op if the session row is
 * missing (the mounted page owns creation) — the localStorage mirror covers it.
 */
export async function appendStagedToSession(
  sessionId: string,
  photo: { id: string } & Record<string, unknown>,
): Promise<void> {
  if (!idbAvailable()) return;
  await withDb((db) =>
    runTx<void>(db, SESSION_STORE, "readwrite", (tx, done) => {
      const store = tx.objectStore(SESSION_STORE);
      const getReq = store.get(sessionId);
      getReq.onsuccess = () => {
        const row = getReq.result as SessionRow | undefined;
        if (!row) return done(undefined);
        const staged = Array.isArray(row.staged) ? row.staged : [];
        if (staged.some((p) => (p as { id?: unknown } | null)?.id === photo.id)) {
          return done(undefined);
        }
        store.put({ ...row, staged: [...staged, photo] });
        done(undefined);
      };
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

// ── AL-03: owner scoping and sign-out ────────────────────────────────

/**
 * The localStorage key holding this user's session id for one workspace.
 * Keyed on BOTH ids: the old single `autolister:sessionId` survived sign-out
 * and workspace switches, so the next person rehydrated the last one's grid.
 */
export function autolisterSessionKey(userId: string, ownerId: string): string {
  return `autolister:${userId}:${ownerId}:sessionId`;
}

/** Every localStorage key AutoLister writes starts with this. */
export const AUTOLISTER_STORAGE_PREFIX = "autolister:";

interface ScopedPhoto {
  id?: unknown;
  storagePath?: unknown;
}
interface ScopedGroup {
  photoIds?: unknown;
  coverId?: unknown;
  [key: string]: unknown;
}

/**
 * Drop everything in a persisted session that does not belong to `ownerId`.
 *
 * A row stamped with a DIFFERENT owner is discarded whole (`foreign: true`).
 * Otherwise any staged photo whose storagePath is not under
 * `${ownerId}/_staging/` is removed, and groups lose those members (a group
 * left empty is dropped, a dropped cover falls back to the first member).
 * `trusted` is false for a legacy row with no owner stamp: its staged
 * metadata is filtered and kept, but its resume blobs must not be re-uploaded
 * because nothing proves whose files they are.
 */
export function scopeSessionToOwner(
  session: PersistedSession,
  ownerId: string,
): { session: PersistedSession | null; foreign: boolean; trusted: boolean } {
  if (session.ownerId && session.ownerId !== ownerId) {
    return { session: null, foreign: true, trusted: false };
  }
  const prefix = `${ownerId}/_staging/`;
  const staged = (Array.isArray(session.staged) ? session.staged : []).filter((p) => {
    const path = (p as ScopedPhoto | null)?.storagePath;
    return typeof path === "string" && path.startsWith(prefix) && !path.includes("..");
  });
  const keep = new Set(staged.map((p) => (p as ScopedPhoto).id));
  const scopeGroups = (groups: unknown[]): unknown[] =>
    groups.flatMap((raw) => {
      const g = raw as ScopedGroup | null;
      if (!g || !Array.isArray(g.photoIds)) return [];
      const photoIds = g.photoIds.filter((id) => keep.has(id));
      if (photoIds.length === 0) return [];
      const coverId = photoIds.includes(g.coverId) ? g.coverId : photoIds[0];
      return [{ ...g, photoIds, coverId }];
    });
  return {
    session: {
      ...session,
      staged,
      groups: scopeGroups(Array.isArray(session.groups) ? session.groups : []),
      undo: Array.isArray(session.undo) ? scopeGroups(session.undo) : session.undo ?? null,
      ownerId,
    },
    foreign: false,
    trusted: session.ownerId === ownerId,
  };
}

/** Delete the whole `autolister` IndexedDB database. Best-effort, never throws. */
export function deleteAutolisterDb(): Promise<void> {
  if (!idbAvailable()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // Another tab holding a connection blocks the delete until it closes;
      // the request still completes then, so don't hold sign-out on it.
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Remove every localStorage key AutoLister wrote. Best-effort. */
export function removeAutolisterLocalStorage(): void {
  try {
    const ls = window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(AUTOLISTER_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) ls.removeItem(k);
  } catch {
    /* blocked storage: nothing to clear */
  }
}
