import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { flushIntakeQueue, queuedIntakeCount } from "@/lib/offline-queue";
import { ensureServiceWorker } from "@/lib/pwa";

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
      const { synced, failed } = await flushIntakeQueue();
      if (synced > 0) await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (failed > 0) {
        toast.error(
          `Synced ${synced}, ${failed} still queued — will retry.`,
          { id: toastId },
        );
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
