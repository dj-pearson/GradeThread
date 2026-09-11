// US-3159: the React wrapper around the cloud folder import.
//
// Same division as use-google-photos-import.ts: the sequence and every rule in
// it live in src/lib/cloud-folder-import.ts, tested without a browser. This file
// owns React state, the real window.open for the consent screen, the real
// toasts, and the one-time "which providers does this deploy even offer" probe.
//
// Anything with a rule in it belongs in the library. Keep it that way.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  type CloudEntry,
  type CloudFolderListing,
  type CloudImportedPhoto,
  type CloudProviderStatus,
  listCloudFolder,
  loadCloudProviders,
  runCloudFolderImport,
} from "@/lib/cloud-folder-import";

export type { CloudEntry, CloudImportedPhoto, CloudProviderStatus };

export interface UseCloudFolderImportOptions {
  /** Gate the probe — no entitlement, no request. */
  enabled: boolean;
  /** Each chunk as it lands. Awaited, so the next chunk waits for it. */
  onPhotos: (photos: CloudImportedPhoto[]) => void | Promise<void>;
  /** Run after a finished import, e.g. to refresh a query. */
  onFinished?: () => void;
}

export interface CloudFolderImportState {
  /** Providers this deploy offers. Empty means render nothing at all. */
  providers: CloudProviderStatus[];
  /** Re-read connection status, e.g. after the consent window closes. */
  refreshProviders: () => void;
  connect: (providerId: string) => void;
  disconnect: (providerId: string) => Promise<void>;
  browse: (providerId: string, path: string) => Promise<CloudFolderListing>;
  importing: boolean;
  progress: { done: number; total: number } | null;
  runImport: (providerId: string, paths: string[]) => Promise<void>;
  cancel: () => void;
}

const notify = {
  info: (m: string) => toast.info(m),
  success: (m: string) => toast.success(m),
  warning: (m: string) => toast.warning(m),
  error: (m: string) => toast.error(m),
};

const fetchEdge = (path: string, init?: { method?: string; body?: string }) =>
  edgeFetch(path, init);

export function useCloudFolderImport({
  enabled,
  onPhotos,
  onFinished,
}: UseCloudFolderImportOptions): CloudFolderImportState {
  const [providers, setProviders] = useState<CloudProviderStatus[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Latest-value refs: a run outlives the render that started it.
  const onPhotosRef = useRef(onPhotos);
  onPhotosRef.current = onPhotos;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const cancelledRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  const refreshProviders = useCallback(() => {
    if (!enabled) return;
    void loadCloudProviders({ fetchEdge })
      .then((list) => {
        if (aliveRef.current) setProviders(list);
      })
      .catch(() => {
        // A deploy with no cloud credentials answers with an empty list, and a
        // network blip should not put a broken button on the page either.
        if (aliveRef.current) setProviders([]);
      });
  }, [enabled]);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  const connect = useCallback((providerId: string) => {
    void edgeFetch(`/api/flipdesk/cloud/${providerId}/oauth/start`)
      .then((r) => r.json())
      .then((j: { consent_url?: string; error?: string }) => {
        if (!j.consent_url) {
          toast.error(j.error ?? "Could not start that connection.");
          return;
        }
        window.open(j.consent_url, "cloudconnect", "width=620,height=760");
        toast.info("Finish in the other window, then come back here.");
      })
      .catch(() => toast.error("Could not start that connection."));
  }, []);

  const disconnect = useCallback(async (providerId: string) => {
    try {
      // US-3378: the response used to be discarded. edgeFetch does not throw on
      // a non-2xx, so a 500 here printed "Disconnected." and then re-rendered
      // the row STILL CONNECTED, so the user was told the opposite of what
      // happened, about a credential they were trying to revoke.
      const res = await edgeFetch(`/api/flipdesk/cloud/${providerId}/disconnect`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Could not disconnect.");
      } else {
        toast.success("Disconnected.");
      }
    } catch {
      toast.error("Could not disconnect.");
    }
    refreshProviders();
  }, [refreshProviders]);

  const browse = useCallback(
    (providerId: string, path: string) => listCloudFolder({ fetchEdge }, providerId, path),
    [],
  );

  const runImport = useCallback(async (providerId: string, paths: string[]) => {
    if (importing) return;
    cancelledRef.current = false;
    setImporting(true);
    setProgress(null);
    try {
      await runCloudFolderImport(
        {
          fetchEdge,
          notify,
          onPhotos: (photos) => onPhotosRef.current(photos),
          onProgress: (done, total) => {
            if (aliveRef.current) setProgress({ done, total });
          },
          cancelled: () => cancelledRef.current,
        },
        providerId,
        paths,
      );
      onFinishedRef.current?.();
    } finally {
      if (aliveRef.current) {
        setImporting(false);
        setProgress(null);
      }
    }
  }, [importing]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  return {
    providers,
    refreshProviders,
    connect,
    disconnect,
    browse,
    importing,
    progress,
    runImport,
    cancel,
  };
}
