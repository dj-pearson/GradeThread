// US-1542 / US-1905 / AL-03: the workbench's persistence, moved out of
// autolister.tsx (which sits at a shrink-only line ceiling) unchanged apart
// from its inputs arriving as arguments.
//
//   - attach/detach the upload store, mirror staged identities into it, claim
//     finished uploads, and report files lost to a hard reload;
//   - rehydrate the session from IndexedDB on mount, scoped to the owner;
//   - persist staged/groups/undo on every change.
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  clearSession,
  idbAvailable,
  loadSession,
  migrateSessionFromLocalStorage,
  saveSession,
  scopeSessionToOwner,
} from "@/lib/autolister-session-idb";
import { type StagedPhoto, useAutolisterUploadStore } from "@/stores/autolister-upload-store";

/** AL-11: how long edits settle before the session is written. */
export const PERSIST_DEBOUNCE_MS = 400;

export interface WorkbenchPersistenceArgs<G> {
  sessionId: string;
  storageKey: string;
  ownerId: string | null;
  staged: StagedPhoto[];
  setStaged: Dispatch<SetStateAction<StagedPhoto[]>>;
  groups: G[];
  setGroups: Dispatch<SetStateAction<G[]>>;
  undoGroupsRef: MutableRefObject<G[] | null>;
  ungroupedSort: string;
  groupEvery: number;
}

export function useWorkbenchPersistence<G>({
  sessionId,
  storageKey,
  ownerId,
  staged,
  setStaged,
  groups,
  setGroups,
  undoGroupsRef,
  ungroupedSort,
  groupEvery,
}: WorkbenchPersistenceArgs<G>): { cancelPendingPersist: () => void } {
  // Finished photos not yet claimed into `staged`.
  const uploadResults = useAutolisterUploadStore((s) => s.results);
  // US-1905: gate persistence until the async IndexedDB rehydrate finishes, so
  // the localStorage-seeded initial state can't clobber a fuller IDB session
  // (localStorage may be stale/truncated on large sessions).
  const hydratedRef = useRef(false);
  const pendingPersistRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const flush = () => pendingPersistRef.current?.();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // US-1542: page ↔ upload-store wiring.
  //
  // Attach/detach: while attached the store skips its own localStorage merge
  // (this page claims results + persists them itself). Detaching hands that
  // responsibility back so uploads finishing mid-navigation are still safe
  // against a hard reload.
  useEffect(() => {
    // The workbench remounts per (user, owner), so sessionId is stable here.
    const store = useAutolisterUploadStore.getState();
    store.attach(sessionId);
    return () => useAutolisterUploadStore.getState().detach();
  }, [sessionId]);

  // Duplicate guards: mirror the staged photos' source signatures/hashes into
  // the store (deleting a photo frees its identity for re-adding; a claim that
  // made it into `staged` is pruned store-side).
  useEffect(() => {
    const sigs = new Set<string>();
    const hashes = new Set<string>();
    for (const p of staged) {
      if (p.sourceSig) sigs.add(p.sourceSig);
      if (p.sourceHash) hashes.add(p.sourceHash);
    }
    useAutolisterUploadStore.getState().syncStagedIdentities(sigs, hashes);
  }, [staged]);

  // Claim finished photos from the store into the page's staged state (deduped
  // by id — a photo merged into localStorage while this page was unmounted may
  // already have rehydrated).
  useEffect(() => {
    if (uploadResults.length === 0) return;
    setStaged((prev) => {
      const have = new Set(prev.map((p) => p.id));
      const fresh = uploadResults.filter((r) => !have.has(r.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    useAutolisterUploadStore.getState().claimResults(uploadResults.map((r) => r.id));
  }, [uploadResults, setStaged]);

  // US-1542 AC3: after a hard reload, Files queued in the previous page life
  // are unrecoverable — say plainly how many need re-adding.
  useEffect(() => {
    const lost = useAutolisterUploadStore.getState().consumeLostUploadCount();
    if (lost > 0) {
      toast.warning(
        `${lost} photo${lost === 1 ? "" : "s"} didn't finish uploading before the page closed.`,
        {
          description:
            "Already-uploaded photos are safe below — add the missing files again to finish.",
          duration: 10_000,
        },
      );
    }
  }, []);

  // US-1905: rehydrate the FULL session from IndexedDB on mount (migrating an
  // existing localStorage session on first run). IDB is authoritative — for a
  // 600-photo session localStorage may be stale or truncated. `hydratedRef`
  // gates the persist effect until this completes, so the localStorage-seeded
  // initial state can't overwrite a fuller IDB session. Undo snapshot restored
  // too. No IndexedDB (some private-browsing modes) → keep the localStorage
  // state and mark hydrated immediately.
  useEffect(() => {
    let cancelled = false;
    let resumeAllowed = Boolean(ownerId);
    (async () => {
      if (idbAvailable()) {
        try {
          const raw = (() => {
            try {
              return window.localStorage.getItem(storageKey);
            } catch {
              return null;
            }
          })();
          const rawLoaded =
            (await migrateSessionFromLocalStorage(sessionId, raw)) ??
            (await loadSession(sessionId));
          // AL-03: a row staged for another owner is dropped whole; a legacy
          // row with no owner stamp keeps only this owner's photos and its
          // queued files are NOT resumed (nothing proves whose they are).
          const scoped = rawLoaded && ownerId ? scopeSessionToOwner(rawLoaded, ownerId) : null;
          if (rawLoaded && (!scoped || !scoped.trusted)) {
            resumeAllowed = false;
            await clearSession(sessionId);
          }
          const loaded = scoped?.session ?? null;
          if (!cancelled && loaded) {
            if (Array.isArray(loaded.staged)) {
              const idbStaged = loaded.staged as StagedPhoto[];
              const idbIds = new Set(idbStaged.map((p) => p.id));
              // Merge, not replace: keep any photo an upload claimed during the
              // async rehydrate window (IDB is authoritative for the rest).
              setStaged((cur) => [...idbStaged, ...cur.filter((p) => !idbIds.has(p.id))]);
            }
            if (Array.isArray(loaded.groups) && loaded.groups.length > 0) {
              setGroups(loaded.groups as G[]);
            }
            if (Array.isArray(loaded.undo)) undoGroupsRef.current = loaded.undo as G[];
          }
        } catch {
          /* keep the localStorage-seeded state */
        }
      }
      if (!cancelled) hydratedRef.current = true;
      // US-1905: resume uploads persisted before a reload (part 2). Runs after
      // the localStorage-derived staged identities are synced, so a photo that
      // finished before the reload isn't re-uploaded.
      if (!cancelled && resumeAllowed) {
        void useAutolisterUploadStore.getState().resumeUploads(sessionId);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist whenever staged / groups change. US-1905: IndexedDB is the primary
  // store (no size limit → a 600-photo session saves fully, undo snapshot
  // included). localStorage remains the fallback when IndexedDB is unavailable,
  // where the US-1541 size-guard (drop `original` snapshots, warn once) still
  // applies. Gated on `hydratedRef` so it can't run before the IDB rehydrate.
  const persistWarnedRef = useRef(false);
  // AL-11: debounced. A 600-photo session was re-serialized on every edit and
  // every claimed upload; now at most once per PERSIST_DEBOUNCE_MS, with the
  // pending write flushed on pagehide and on unmount so nothing is lost.
  useEffect(() => {
    if (typeof window === "undefined" || !hydratedRef.current) return;
    const persist = () => {
      pendingPersistRef.current = null;
      if (idbAvailable()) {
        void saveSession(sessionId, {
          staged,
          groups,
          undo: undoGroupsRef.current,
          sort: { ungroupedSort, groupEvery },
          updatedAt: Date.now(),
          ownerId: ownerId ?? undefined,
        });
        return;
      }
      // Fallback: localStorage, size-guarded (only reached without IndexedDB).
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({ staged, groups }));
        return;
      } catch {
        /* fall through to the slimmed retry */
      }
      try {
        const slimmed = staged.map((p) => {
          const copy = { ...p };
          delete copy.original;
          return copy;
        });
        window.localStorage.setItem(storageKey, JSON.stringify({ staged: slimmed, groups }));
        if (!persistWarnedRef.current) {
          persistWarnedRef.current = true;
          toast.warning(
            "This session is too large to save fully — it will still restore after a reload, but photo-edit undo snapshots won't.",
          );
        }
      } catch {
        if (!persistWarnedRef.current) {
          persistWarnedRef.current = true;
          toast.warning(
            "Couldn't save this session locally (storage is full or disabled) — a reload will lose the grouping. Uploaded photos are safe on the server.",
          );
        }
      }
    };
    pendingPersistRef.current = persist;
    const timer = window.setTimeout(persist, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [staged, groups, storageKey, ungroupedSort, groupEvery, ownerId, sessionId, undoGroupsRef]);

  // Generate clears the stored session and leaves; a pending debounced write
  // must not put it back.
  return { cancelPendingPersist: () => { pendingPersistRef.current = null; } };
}
