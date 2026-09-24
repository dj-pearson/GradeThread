// AL-13: a staged-photo delete used to remove the storage objects the moment
// the seller pressed Delete, with no confirm and no way back. The photos now
// leave the grid at once, but their objects are only removed once the Undo
// window closes (or the page is hidden). Undo in time sends no storage delete.
import { useEffect, useRef } from "react";
import { discardStagedObjects } from "./discard-staged-objects";

/** How long the Undo toast keeps a delete revocable. */
export const DELETE_UNDO_MS = 8_000;

type Discard = (paths: string[]) => void;

/** The timer bookkeeping, framework-free so it can be tested on its own. */
export class PendingDeletes {
  private readonly pending = new Map<string, { paths: string[]; timer: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly discard: Discard,
    private readonly delayMs = DELETE_UNDO_MS,
  ) {}

  /** Queue `paths` for removal after the delay. Returns a handle for undo. */
  schedule(paths: string[]): string {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => this.commit(id), this.delayMs);
    this.pending.set(id, { paths, timer });
    return id;
  }

  /** Undo: forget the queued removal. False when it already ran. */
  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    return true;
  }

  /** Remove one queued batch now. */
  commit(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (p.paths.length > 0) this.discard(p.paths);
  }

  /** Remove everything still queued (page hidden, workbench unmounted). */
  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.commit(id);
  }
}

/** The workbench's PendingDeletes, flushed on pagehide and on unmount. */
export function usePendingStagedDeletes(): PendingDeletes {
  const ref = useRef<PendingDeletes | null>(null);
  if (!ref.current) {
    // US-3389: notified, because the seller pressed Delete.
    ref.current = new PendingDeletes((paths) =>
      void discardStagedObjects(paths, "delete staged photos", { notify: true }),
    );
  }
  useEffect(() => {
    const deletes = ref.current!;
    const flush = () => deletes.flushAll();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  return ref.current;
}
