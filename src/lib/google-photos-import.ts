// US-3140: the Google Photos import run, with every effect injected.
//
// This is the AutoLister's import flow (US-1539) lifted out of the page so a
// second surface — the Composer's shared PhotoUploader — can run the identical
// sequence instead of growing a second copy of it. The sequence has four
// non-obvious rules in it, each of which cost a bug to learn:
//
//   1. The picker window closing is NOT a cancellation signal. Google's picker
//      tells the user to close it and finish "in the other window", so closing
//      is the NORMAL completion path and `mediaItemsSet` flips a beat later.
//      Stopping on close races the very poll that returns ready. We poll until
//      the SERVER says ready (then we close the window ourselves), the server
//      says the session is gone, or the caller cancels.
//   2. There is no short wall-clock deadline. The old 4-minute cap was measured
//      from the moment the popup opened, so the time the seller spent picking
//      burned the whole budget; a 200-photo pick timed out before they hit Done.
//      pickMaxMs is an outer safety net, not a schedule.
//   3. The download is CHUNKED and paced. The edge downloads, validates,
//      EXIF-strips and re-uploads every picked photo, so one request for all of
//      them outlives the proxy's patience.
//   4. The server is the authority on the cursor. Only fall back to our own
//      arithmetic when it did not say.
//
// Nothing here touches React, `window`, `fetch`, `sonner` or a timer directly —
// they all arrive through GooglePhotosImportDeps, which is what lets the whole
// sequence be tested without a browser. The React wrapper is
// src/hooks/use-google-photos-import.ts.

/** One photo the edge has already downloaded, validated and re-uploaded. */
export interface GooglePhotosImportedPhoto {
  url: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number;
  capturedAtMs: number | null;
}

/** The bit of a Response this module actually uses. */
export interface GooglePhotosFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** The bit of a popup handle this module actually uses. */
export interface GooglePhotosPopup {
  close: () => void;
}

/** Toast sink. Injected so a test asserts on messages instead of rendering. */
export interface GooglePhotosNotifier {
  info: (message: string, opts?: { durationMs?: number }) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
}

/** How a run ended. `imported` is the only outcome that added photos. */
export type GooglePhotosImportStatus =
  | "imported"
  | "empty"
  | "cancelled"
  | "expired"
  | "timed-out"
  | "not-configured"
  | "popup-blocked"
  | "failed";

export interface GooglePhotosImportResult {
  status: GooglePhotosImportStatus;
  /** Photos successfully added across every chunk. */
  imported: number;
  /** Photos the edge could not read and skipped. */
  errors: number;
  /** How many the seller picked, once the first chunk reports it. */
  total: number;
}

export interface GooglePhotosImportDeps {
  /** `edgeFetch`. Only the path is passed; the caller owns auth headers. */
  fetchEdge: (
    path: string,
    init?: { method?: string },
  ) => Promise<GooglePhotosFetchResponse>;
  /** `window.open`. Returns null when the browser blocked the popup. */
  openWindow: (url: string) => GooglePhotosPopup | null;
  /** Called with each chunk as it lands, so a long pull shows steady progress
   *  instead of one freeze. May be async — the run waits for it. */
  onPhotos: (photos: GooglePhotosImportedPhoto[]) => void | Promise<void>;
  /** Download progress, or null when there is none to show. */
  onProgress: (progress: { done: number; total: number } | null) => void;
  notify: GooglePhotosNotifier;
  /** Cancels the run at the next poll or chunk boundary. */
  signal?: AbortSignal;
  /** Injected clock and sleep so a test does not wait out a real poll. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  chunkPauseMs?: number;
  pickMaxMs?: number;
  /** Cap the edge enforces, quoted back to the seller when they hit it. */
  maxImport?: number;
  /** What Cancel says once the download has started. The AutoLister points at
   *  its own grid ("below"); another surface words it differently. */
  stoppedMessage?: string;
}

// Defaults mirror MAX_IMPORT in
// services/edge-functions/src/routes/flipdesk-google-photos.ts — these move
// together.
export const GP_MAX_IMPORT = 200;
export const GP_CHUNK_PAUSE_MS = 750;
export const GP_POLL_INTERVAL_MS = 2500;
// Outer safety net only — see rule 2 in the header.
export const GP_PICK_MAX_MS = 45 * 60_000;

const PICK_PROMPT =
  "Pick your photos in the Google window and hit Done — the window closes on " +
  "its own and they'll appear here.";

interface StartPayload {
  session_id?: string;
  consent_url?: string;
  picker_uri?: string;
  error?: string;
}

interface ImportPayload {
  photos?: GooglePhotosImportedPhoto[];
  total?: number;
  nextOffset?: number;
  errors?: number;
  done?: boolean;
  error?: string;
}

async function readJson<T>(res: GooglePhotosFetchResponse): Promise<T> {
  try {
    return ((await res.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}

function result(
  status: GooglePhotosImportStatus,
  imported = 0,
  errors = 0,
  total = 0,
): GooglePhotosImportResult {
  return { status, imported, errors, total };
}

/**
 * Run one import end to end: start the session, open the picker, wait for the
 * seller to finish, then pull the picks down in paced chunks.
 *
 * Never throws for an expected outcome — a blocked popup, an expired session, a
 * cancel and a server error all come back as a status, with the seller already
 * told through `notify`.
 */
export async function runGooglePhotosImport(
  deps: GooglePhotosImportDeps,
): Promise<GooglePhotosImportResult> {
  const {
    fetchEdge,
    openWindow,
    onPhotos,
    onProgress,
    notify,
    signal,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    pollIntervalMs = GP_POLL_INTERVAL_MS,
    chunkPauseMs = GP_CHUNK_PAUSE_MS,
    pickMaxMs = GP_PICK_MAX_MS,
    maxImport = GP_MAX_IMPORT,
    stoppedMessage = "Stopped — the photos already brought over are kept.",
  } = deps;

  const aborted = () => signal?.aborted === true;

  // ── 1. Start the session ────────────────────────────────────────────────
  let startRes: GooglePhotosFetchResponse;
  try {
    startRes = await fetchEdge("/api/flipdesk/google/photos/oauth/start");
  } catch {
    notify.error("Could not start Google Photos.");
    return result("failed");
  }
  if (startRes.status === 503) {
    notify.error("Google Photos import isn't configured yet.");
    return result("not-configured");
  }
  const start = await readJson<StartPayload>(startRes);
  // The fast path returns picker_uri (already signed in — straight to the
  // picker); a first-time import returns consent_url.
  const openUrl = start.picker_uri || start.consent_url;
  if (!startRes.ok || !start.session_id || !openUrl) {
    notify.error(start.error || "Could not start Google Photos import.");
    return result("failed");
  }
  const sessionId = start.session_id;

  // ── 2. Open the picker ──────────────────────────────────────────────────
  const popup = openWindow(openUrl);
  if (!popup) {
    notify.error("Please allow popups to import from Google Photos.");
    return result("popup-blocked");
  }
  notify.info(PICK_PROMPT, { durationMs: 8000 });

  // ── 3. Wait for the seller to finish picking ────────────────────────────
  const startedAt = now();
  for (;;) {
    if (aborted()) {
      notify.info("Google Photos import cancelled.");
      return result("cancelled");
    }
    let ready = false;
    try {
      const pr = await fetchEdge(
        `/api/flipdesk/google/photos/poll?session=${sessionId}`,
      );
      if (pr.status === 404 || pr.status === 410) {
        notify.info("The Google Photos session expired — start the import again.");
        return result("expired");
      }
      ready = (await readJson<{ ready?: boolean }>(pr)).ready === true;
    } catch {
      // Transient — keep polling. The terminal signals are the server saying
      // the session is gone, the caller cancelling, or pickMaxMs.
    }
    if (ready) break;
    if (now() - startedAt > pickMaxMs) {
      notify.info(
        "Google Photos import timed out — if you finished picking, try again.",
      );
      return result("timed-out");
    }
    await sleep(pollIntervalMs);
  }

  // Picking is over, so close the window for them. The COOP header is
  // `same-origin-allow-popups` (see public/_headers), which is what keeps this
  // handle alive — under a stricter COOP `close()` silently does nothing.
  try {
    popup.close();
  } catch {
    // Handle lost. The seller can close it themselves; the import continues.
  }

  // ── 4. Pull the picks down in paced chunks ──────────────────────────────
  onProgress({ done: 0, total: 0 });
  let offset = 0;
  let total = 0;
  let imported = 0;
  let errors = 0;
  for (;;) {
    if (aborted()) {
      onProgress(null);
      notify.info(stoppedMessage);
      return result("cancelled", imported, errors, total);
    }
    let res: GooglePhotosFetchResponse;
    try {
      res = await fetchEdge(
        `/api/flipdesk/google/photos/import?session=${sessionId}&offset=${offset}`,
        { method: "POST" },
      );
    } catch {
      onProgress(null);
      notify.error("Google Photos import failed.");
      return result("failed", imported, errors, total);
    }
    const payload = await readJson<ImportPayload>(res);
    if (!res.ok) {
      onProgress(null);
      notify.error(payload.error || `Google Photos import failed (${res.status}).`);
      return result("failed", imported, errors, total);
    }

    const added = payload.photos ?? [];
    if (added.length > 0) await onPhotos(added);
    imported += added.length;
    errors += payload.errors ?? 0;
    total = payload.total ?? total;
    onProgress({ done: imported, total });

    const next = payload.nextOffset ?? offset + added.length;
    if (payload.done || next <= offset || (total > 0 && next >= total)) break;
    offset = next;
    await sleep(chunkPauseMs);
  }
  onProgress(null);

  if (imported === 0) {
    notify.warning("No photos were imported.");
    return result("empty", 0, errors, total);
  }
  notify.success(
    `Imported ${imported} photo${imported === 1 ? "" : "s"} from Google Photos.` +
      (errors > 0 ? ` ${errors} couldn't be read and were skipped.` : ""),
  );
  if (total >= maxImport) {
    notify.info(
      `Google Photos imports are capped at ${maxImport} photos at a time — ` +
        `run it again for the rest.`,
    );
  }
  return result("imported", imported, errors, total);
}
