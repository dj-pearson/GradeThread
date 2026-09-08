// US-3140: the React wrapper around runGooglePhotosImport.
//
// The sequence itself — start, popup, poll, chunked download, cancel — lives in
// src/lib/google-photos-import.ts with every effect injected, and is covered by
// src/lib/google-photos-import.test.ts. This file owns only what the library
// deliberately does not: React state, the real `window.open`, the real toasts,
// the one-time "is it configured server-side" check, and teardown on unmount.
//
// Keep it that way. Anything with a rule in it belongs in the library, where it
// can be tested without a browser.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  type GooglePhotosImportedPhoto,
  type GooglePhotosImportResult,
  type GooglePhotosNotifier,
  runGooglePhotosImport,
} from "@/lib/google-photos-import";

export type { GooglePhotosImportedPhoto } from "@/lib/google-photos-import";

export interface UseGooglePhotosImportOptions {
  /** Gate the config probe — no entitlement, no request. */
  enabled: boolean;
  /** Each chunk as it lands. Awaited, so the next chunk waits for it. */
  onPhotos: (photos: GooglePhotosImportedPhoto[]) => void | Promise<void>;
  /** What Cancel says once the download has started. */
  stoppedMessage?: string;
  /** Run after a finished import, e.g. to refresh a query. */
  onFinished?: (result: GooglePhotosImportResult) => void;
}

export interface GooglePhotosImportState {
  /** Whether the server has Google credentials — gate the button on this. */
  configured: boolean;
  importing: boolean;
  progress: { done: number; total: number } | null;
  start: () => void;
  cancel: () => void;
}

const notifier: GooglePhotosNotifier = {
  info: (message, opts) =>
    toast.info(message, opts?.durationMs ? { duration: opts.durationMs } : undefined),
  success: (message) => toast.success(message),
  warning: (message) => toast.warning(message),
  error: (message) => toast.error(message),
};

export function useGooglePhotosImport({
  enabled,
  onPhotos,
  stoppedMessage,
  onFinished,
}: UseGooglePhotosImportOptions): GooglePhotosImportState {
  const [configured, setConfigured] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  // Latest-value refs: a run outlives the render that started it.
  const onPhotosRef = useRef(onPhotos);
  onPhotosRef.current = onPhotos;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const abortRef = useRef<AbortController | null>(null);

  // One-time check that the import will actually work, so the button only
  // appears when it does.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void edgeFetch("/api/flipdesk/google/photos/config")
      .then((r) => r.json())
      .then((j: { configured?: boolean }) => {
        if (!cancelled) setConfigured(!!j.configured);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // The poll runs to its own timeout rather than stopping when the picker
  // window closes, so it must be torn down explicitly.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(() => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setImporting(true);
    void runGooglePhotosImport({
      fetchEdge: (path, init) => edgeFetch(path, init),
      openWindow: (url) => window.open(url, "gphotos", "width=620,height=760"),
      onPhotos: (photos) => onPhotosRef.current(photos),
      onProgress: setProgress,
      notify: notifier,
      signal: controller.signal,
      stoppedMessage,
    })
      .then((res) => onFinishedRef.current?.(res))
      .finally(() => {
        abortRef.current = null;
        setImporting(false);
        setProgress(null);
      });
  }, [stoppedMessage]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { configured, importing, progress, start, cancel };
}
