import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  flushIntakeQueueExclusive,
  queueCounts,
  type QueueCounts,
} from "@/lib/offline-queue";
import { SKU_PREVIEW_KEY, SKU_SEQUENCE_KEY } from "@/hooks/use-sku-sequence";
import { ensureServiceWorker } from "@/lib/pwa";
import { useAuthStore } from "@/stores/auth-store";

export function offlinePhotosPendingMessage(
  synced: number,
  photosPending: number,
): string {
  const photos = `${photosPending} photo${photosPending === 1 ? "" : "s"} pending`;
  if (synced === 0) return `${photos}. Will retry.`;
  return `Saved ${synced} offline item${synced === 1 ? "" : "s"}, ${photos}. Will retry.`;
}

/** Per signed-in user; the queue itself is scoped the same way. */
export const OFFLINE_INTAKE_COUNT_KEY = "offline_intake_count";

const NO_COUNTS: QueueCounts = { itemsPending: 0, photosPending: 0 };

/**
 * Retry delays after a flush that left work behind while online: a server
 * refusal or a flaky connection. 30s, then 2m, then every 10m.
 */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * What the intake page shows: the signed-in user's queue counts and whether
 * the device is online. The syncing itself lives in <OfflineIntakeSync/>, which
 * is mounted once for the whole dashboard.
 */
export function useOfflineIntakeStatus() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const online = useOnline();
  // The intake page is the offline surface; it registers the worker.
  useEffect(() => {
    ensureServiceWorker();
  }, []);
  const { data: counts = NO_COUNTS } = useQuery({
    queryKey: [OFFLINE_INTAKE_COUNT_KEY, userId],
    enabled: !!userId,
    queryFn: async () => {
      try {
        return await queueCounts(userId!);
      } catch {
        return NO_COUNTS; // IndexedDB unavailable
      }
    },
  });
  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: [OFFLINE_INTAKE_COUNT_KEY] }),
    [qc],
  );
  return {
    online,
    pending: counts.itemsPending,
    photosPending: counts.photosPending,
    refresh,
  };
}

/**
 * Drains the offline intake queue from anywhere in the dashboard (US-134).
 * It used to be mounted on the intake page alone, so a seller who reconnected
 * on another page never synced. Flushes on mount, on reconnect and when the
 * tab becomes visible, and retries with backoff while work is left over.
 * Headless: renders nothing.
 */
export function OfflineIntakeSync() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const retryRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; step: number }>({
    timer: null,
    step: 0,
  });

  const sync = useCallback(async () => {
    if (!userId || typeof navigator === "undefined" || !navigator.onLine) return;
    let counts: QueueCounts;
    try {
      counts = await queueCounts(userId);
    } catch {
      return;
    }
    const total = counts.itemsPending + counts.photosPending;
    if (total === 0) return;

    const label =
      counts.itemsPending > 0
        ? `${counts.itemsPending} offline item${counts.itemsPending === 1 ? "" : "s"}`
        : `${counts.photosPending} offline photo${counts.photosPending === 1 ? "" : "s"}`;
    const toastId = toast.loading(`Syncing ${label}...`);
    let leftOver = false;
    try {
      const res = await flushIntakeQueueExclusive(userId);
      if (res === null) {
        // Another tab (or a flush already running here) has it.
        toast.dismiss(toastId);
        return;
      }
      const {
        synced,
        syncedIds,
        failed,
        firstError,
        photosDropped,
        photosPending,
        firstPhotoError,
        photosUnprocessable,
        firstUnprocessableError,
      } = res;
      leftOver = failed > 0 || photosPending > 0;
      // A flush with synced === 0 can still have uploaded the photos of an item
      // saved on an earlier flush, so this does not wait for a new item.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // A queued item can carry a source created offline and its photos.
      await qc.invalidateQueries({ queryKey: ["sources"] });
      await qc.invalidateQueries({ queryKey: ["item_photos"] });
      // A synced item took the next SKU number.
      await qc.invalidateQueries({ queryKey: [SKU_SEQUENCE_KEY] });
      await qc.invalidateQueries({ queryKey: [SKU_PREVIEW_KEY] });
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
        // every single time.
        toast.error(`Synced ${synced}, ${failed} still queued. Will retry.`, {
          id: toastId,
          description: firstError ?? undefined,
          duration: 10_000,
        });
      } else if (photosPending > 0) {
        // The items are saved; only photos are left. Calling that a failure
        // would send the seller to re-enter an item that already exists.
        toast.warning(offlinePhotosPendingMessage(synced, photosPending), {
          id: toastId,
          description: firstPhotoError ?? undefined,
          duration: 10_000,
        });
      } else if (synced > 0) {
        const n = syncedIds.length;
        toast.success(`Synced ${synced} offline item${synced === 1 ? "" : "s"}.`, {
          id: toastId,
          action:
            n > 0
              ? {
                  label: `Review ${n} item${n === 1 ? "" : "s"}`,
                  onClick: () =>
                    navigate(
                      n === 1
                        ? `/dashboard/flipdesk/items?focus=${syncedIds[0]}`
                        : "/dashboard/flipdesk/items",
                    ),
                }
              : undefined,
        });
      } else {
        toast.success("Offline photos uploaded.", { id: toastId });
      }
    } catch {
      leftOver = true;
      toast.error("Offline sync failed. Will retry.", { id: toastId });
    } finally {
      await qc.invalidateQueries({ queryKey: [OFFLINE_INTAKE_COUNT_KEY] });
    }

    // Backoff while online and something is still waiting; reset once clean.
    const r = retryRef.current;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (leftOver) {
      const delay = RETRY_DELAYS_MS[Math.min(r.step, RETRY_DELAYS_MS.length - 1)]!;
      r.step++;
      r.timer = setTimeout(() => {
        r.timer = null;
        void sync();
      }, delay);
    } else {
      r.step = 0;
    }
  }, [qc, userId, navigate]);

  useEffect(() => {
    if (!userId) return;
    const r = retryRef.current;
    void sync();
    const onOnline = () => {
      r.step = 0;
      void sync();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      // Unmount or sign-out (userId changes): no retry may fire for them.
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      r.step = 0;
    };
  }, [sync, userId]);

  return null;
}
