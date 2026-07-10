import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  deleteBlob,
  evictOldestBlobs,
  idbAvailable,
  listBlobs,
  loadSession,
  migrateSessionFromLocalStorage,
  type PersistedBlob,
  putBlob,
  saveSession,
} from "./autolister-session-idb";

// US-1905: fake-indexeddb coverage — happy path, migration, quota-eviction,
// and the no-IDB fallback.

function delDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("autolister");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

const blob = (taskId: string, sessionId: string, createdAt: number): PersistedBlob => ({
  taskId,
  sessionId,
  sig: `${taskId}-sig`,
  blob: new Blob([taskId], { type: "text/plain" }),
  createdAt,
});

beforeEach(async () => {
  await delDb();
});

describe("session state (happy path)", () => {
  it("round-trips a session and clears it", async () => {
    await saveSession("s1", {
      staged: [{ id: "p1" }],
      groups: [{ id: "g1", photoIds: ["p1"] }],
      undo: [{ id: "g0" }],
      sort: { ungroupedSort: "name", groupEvery: 4 },
      updatedAt: 123,
    });
    const loaded = await loadSession("s1");
    expect(loaded?.staged).toEqual([{ id: "p1" }]);
    expect(loaded?.groups).toEqual([{ id: "g1", photoIds: ["p1"] }]);
    expect(loaded?.undo).toEqual([{ id: "g0" }]);
    expect(loaded?.sort).toEqual({ ungroupedSort: "name", groupEvery: 4 });

    await clearSession("s1");
    expect(await loadSession("s1")).toBeNull();
  });

  it("returns null for an unknown session", async () => {
    expect(await loadSession("nope")).toBeNull();
  });
});

describe("upload blobs", () => {
  it("persists, lists oldest-first, and deletes", async () => {
    await putBlob(blob("t3", "s1", 300));
    await putBlob(blob("t1", "s1", 100));
    await putBlob(blob("t2", "s1", 200));
    await putBlob(blob("other", "s2", 50)); // different session

    const s1 = await listBlobs("s1");
    expect(s1.map((b) => b.taskId)).toEqual(["t1", "t2", "t3"]); // by createdAt
    expect(await listBlobs("s2")).toHaveLength(1);

    await deleteBlob("t2");
    expect((await listBlobs("s1")).map((b) => b.taskId)).toEqual(["t1", "t3"]);
  });

  it("clearSession removes the session's blobs but not another session's", async () => {
    await putBlob(blob("t1", "s1", 100));
    await putBlob(blob("t2", "s2", 100));
    await clearSession("s1");
    expect(await listBlobs("s1")).toEqual([]);
    expect(await listBlobs("s2")).toHaveLength(1);
  });
});

describe("quota eviction (oldest-first)", () => {
  it("evicts the N oldest blobs of a session", async () => {
    for (const [id, t] of [["a", 10], ["b", 20], ["c", 30], ["d", 40]] as const) {
      await putBlob(blob(id, "s1", t));
    }
    const evicted = await evictOldestBlobs("s1", 2);
    expect(evicted).toBe(2);
    expect((await listBlobs("s1")).map((b) => b.taskId)).toEqual(["c", "d"]);
  });

  it("evicts at most what exists and never negative", async () => {
    await putBlob(blob("a", "s1", 10));
    expect(await evictOldestBlobs("s1", 5)).toBe(1);
    expect(await evictOldestBlobs("s1", 0)).toBe(0);
  });
});

describe("migration from localStorage", () => {
  it("copies an existing localStorage session into IDB once", async () => {
    const raw = JSON.stringify({ staged: [{ id: "p1" }], groups: [{ id: "g1" }] });
    const migrated = await migrateSessionFromLocalStorage("s1", raw);
    expect(migrated?.staged).toEqual([{ id: "p1" }]);
    expect((await loadSession("s1"))?.groups).toEqual([{ id: "g1" }]);
  });

  it("does not overwrite an existing IDB session", async () => {
    await saveSession("s1", { staged: [{ id: "keep" }], groups: [], updatedAt: 1 });
    const raw = JSON.stringify({ staged: [{ id: "stale" }], groups: [] });
    const result = await migrateSessionFromLocalStorage("s1", raw);
    expect(result?.staged).toEqual([{ id: "keep" }]); // existing wins
  });

  it("returns null when there is nothing to migrate", async () => {
    expect(await migrateSessionFromLocalStorage("s1", null)).toBeNull();
    expect(await migrateSessionFromLocalStorage("s1", "not-json")).toBeNull();
  });
});

describe("fallback when IndexedDB is unavailable", () => {
  let saved: typeof globalThis.indexedDB;
  beforeEach(() => {
    saved = globalThis.indexedDB;
    // @ts-expect-error — simulate a browser without IndexedDB
    delete globalThis.indexedDB;
  });
  afterEach(() => {
    globalThis.indexedDB = saved;
  });

  it("no-ops safely so callers can fall back to localStorage", async () => {
    expect(idbAvailable()).toBe(false);
    await expect(saveSession("s1", { staged: [], groups: [], updatedAt: 0 })).resolves.toBeUndefined();
    expect(await loadSession("s1")).toBeNull();
    expect(await listBlobs("s1")).toEqual([]);
    expect(await putBlob(blob("t", "s1", 1))).toBe(false);
    expect(await migrateSessionFromLocalStorage("s1", "{}")).toBeNull();
  });
});
