import { useCallback, useEffect, useRef, useState } from "react";
import { useTenantKey } from "@/hooks/use-tenant-key";

// OM-08: unsent text that outlives the row it was typed in.
//
// A counter price, its note, a reply, and the AI draft behind any of them
// lived in the detail panel's own state. The panel unmounts when the row
// collapses, when another row opens, on a page or tab change, and when the
// layout crosses the md breakpoint (the table and the phone cards are two
// separate trees). Each of those threw the text away, including a draft the
// seller had spent an AI action on.
//
// The drafts live with the PANEL instead, keyed by the offer or message id,
// and are mirrored to sessionStorage so a reload inside the tab keeps them.
// Session, not local: an unsent counter from yesterday is not a draft, it is a
// stale price. The key carries the tenant so one workspace's drafts never
// appear in another's.
//
// Storage can be missing or throw (private windows, blocked site data), so
// every access is wrapped and the in-memory map is the source of truth.

function readStored<T>(storageKey: string): Record<string, T> {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeStored<T>(storageKey: string, value: Record<string, T>): void {
  try {
    if (Object.keys(value).length === 0) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage is a convenience here; the in-memory copy still holds the text.
  }
}

export interface SessionDrafts<T> {
  get: (id: string) => T | undefined;
  set: (id: string, value: T) => void;
  clear: (id: string) => void;
  /** Drop every draft whose id is not in `ids` (the row left the list). */
  retain: (ids: Iterable<string>) => void;
  ids: string[];
}

export function useSessionDrafts<T>(namespace: string): SessionDrafts<T> {
  const tenantKey = useTenantKey();
  const storageKey = `${tenantKey ?? "anon"}:${namespace}`;
  const [drafts, setDrafts] = useState<Record<string, T>>(() => readStored<T>(storageKey));

  // A workspace switch changes the key: load that workspace's drafts rather
  // than carrying the previous one's across.
  const loadedFor = useRef(storageKey);
  useEffect(() => {
    if (loadedFor.current === storageKey) return;
    loadedFor.current = storageKey;
    setDrafts(readStored<T>(storageKey));
  }, [storageKey]);

  const update = useCallback(
    (fn: (prev: Record<string, T>) => Record<string, T>) => {
      setDrafts((prev) => {
        const next = fn(prev);
        if (next === prev) return prev;
        writeStored(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const get = useCallback((id: string) => drafts[id], [drafts]);
  const set = useCallback(
    (id: string, value: T) => update((prev) => ({ ...prev, [id]: value })),
    [update],
  );
  const clear = useCallback(
    (id: string) =>
      update((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    [update],
  );
  const retain = useCallback(
    (ids: Iterable<string>) =>
      update((prev) => {
        const keep = new Set(ids);
        const stale = Object.keys(prev).filter((id) => !keep.has(id));
        if (stale.length === 0) return prev;
        const next = { ...prev };
        for (const id of stale) delete next[id];
        return next;
      }),
    [update],
  );

  return { get, set, clear, retain, ids: Object.keys(drafts) };
}
