import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { flushIntakeQueue, queuedIntakeCount } from "@/lib/offline-queue";
import { ensureServiceWorker } from "@/lib/pwa";

export function offlinePhotosPendingMessage(
  synced: number,
  photosPending: number,
): string {
  const photos = `${photosPending} photo${photosPending === 1 ? "" : "s"} pending`;
  if (synced === 0) return `${photos}. Will retry.`;
  return `Saved ${synced} offline item${synced === 1 ? "" : "s"}, ${photos}. Will retry.`;
}

// Tracks the offline intake queue and flushes it to Supabase whenever the
// device reconnects (US-134). Returns the current online state and the count
// of items still queued so the intake page can surface status.
export function useOfflineIntakeSync() {
  const qc = useQueryClient();
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const syncingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setPending(await queuedIntakeCount());
    } catch {
      /* IndexedDB unavailable — ignore */
    }
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    let total = 0;
    try {
      total = await queuedIntakeCount();
    } catch {
      return;
    }
    if (total === 0) return;

    syncingRef.current = true;
    const toastId = toast.loading(
      `Syncing ${total} offline item${total === 1 ? "" : "s"}…`,
    );
    try {
      const {
        synced,
        failed,
        firstError,
        photosDropped,
        photosPending,
        firstPhotoError,
        photosUnprocessable,
        firstUnprocessableError,
      } = await flushIntakeQueue();
      // A flush with synced === 0 can still have uploaded the photos of an item
      // saved on an earlier flush, so this does not wait for a new item.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // A queued item can carry a source created offline and its photos.
      await qc.invalidateQueries({ queryKey: ["sources"] });
      await qc.invalidateQueries({ queryKey: ["item_photos"] });
      if (photosDropped > 0) {
        toast.warning(
          `${photosDropped} offline photo${photosDropped === 1 ? "" : "s"} could not be uploaded. Add ${photosDropped === 1 ? "it" : "them"} from the item page.`,
          { duration: 10_000 },
        );
      }
      if (photosUnprocessable > 0) {
        toast.warning(
          `${photosUnprocessable} offline photo${photosUnprocessable === 1 ? "" : "s"} could not be prepared on this device. Add ${photosUnprocessable === 1 ? "a different one" : "different ones"} from the item page.`,
          { description: firstUnprocessableError ?? undefined, duration: 10_000 },
        );
      }
      if (failed > 0) {
        // US-2364: name the reason. "Will retry" on its own is fine for a lost
        // connection and actively misleading for a row the server will refuse
        // every single time — the seller waits for a sync that can never happen.
        toast.error(
          `Synced ${synced}, ${failed} still queued — will retry.`,
          { id: toastId, description: firstError ?? undefined, duration: 10_000 },
        );
      } else if (photosPending > 0) {
        // The items are saved; only photos are left. Calling that a failure
        // would send the seller to re-enter an item that already exists.
        toast.warning(offlinePhotosPendingMessage(synced, photosPending), {
          id: toastId,
          description: firstPhotoError ?? undefined,
          duration: 10_000,
        });
      } else {
        toast.success(
          `Synced ${synced} offline item${synced === 1 ? "" : "s"}.`,
          { id: toastId },
        );
      }
    } catch {
      toast.error("Offline sync failed — will retry.", { id: toastId });
    } finally {
      syncingRef.current = false;
      await refresh();
    }
  }, [qc, refresh]);

  useEffect(() => {
    ensureServiceWorker();
    void refresh();
    void sync();

    const onOnline = () => {
      setOnline(true);
      void sync();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [sync, refresh]);

  return { pending, online, refresh, sync };
}
