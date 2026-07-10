import { create } from "zustand";
import { toast } from "sonner";
import { forceRefreshAccessToken } from "@/lib/auth-token";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";
import { readCaptureTime } from "@/lib/exif";
import { ImageDecodeError, processStagedImage } from "@/lib/image-worker-pool";
import { MediaIntakeError, normalizeToImageFile } from "@/lib/media-intake";
import { runWithConcurrency } from "@/lib/concurrency";
import {
  appendStagedToSession,
  deleteBlob,
  idbAvailable,
  listBlobs,
  putBlob,
} from "@/lib/autolister-session-idb";
import {
  backoffDelayMs,
  RATE_LIMIT_MAX_ATTEMPTS,
  RateLimitedError,
  SlidingWindowLimiter,
  sleep,
} from "@/lib/upload-rate-limit";

// US-1542: the AutoLister upload pipeline, lifted out of the intake page into
// an app-level store. The pipeline used to live inside autolister.tsx, so ANY
// in-app navigation unmounted the component and abandoned every in-flight
// file. Now the queue, the per-file pipeline (dedup → EXIF → normalize →
// compress → validate → paced upload), and the staged-photo outputs all live
// here; the page ATTACHES to render progress and CLAIMS finished photos, and
// navigating away changes nothing about the uploads.
//
// Division of labor with the page:
//   • The page owns the `staged` session state (grid, grouping, localStorage
//     persistence). It syncs its staged photo identities into this store (for
//     duplicate detection) and claims `results` as they appear.
//   • While the page is DETACHED, each finished photo is also merged straight
//     into the persisted localStorage session, so even a hard reload while
//     browsing elsewhere can't lose an uploaded photo.
//   • Files themselves are NOT survivable across a full page unload — the
//     beforeunload guard warns, and `lostUploadCount()` lets the page say
//     plainly how many files need re-adding after a reload.

// ── Types (moved from autolister.tsx) ───────────────────────────────

export interface StagedPhoto {
  id: string;
  url: string;
  storagePath: string;
  thumbnailUrl: string | null;
  thumbnailStoragePath: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  // US-532 auto-grouping signals, captured at upload. Stored as epoch-ms (not a
  // Date) so the localStorage session round-trips cleanly. phash is the 16-hex
  // dHash compressImage already computes (empty string if unavailable).
  capturedAtMs: number | null;
  phash: string;
  // Duplicate guards for the SOURCE file this photo came from (optional →
  // older persisted sessions round-trip). sourceSig is the cheap identity
  // (name|size|mtime); sourceHash is the SHA-256 of the original bytes, which
  // also catches renamed copies. Photos without them (Google Photos imports,
  // pre-upgrade sessions) simply don't participate in dedup.
  sourceSig?: string;
  sourceHash?: string;
  // Original filename, for provenance (US-1539) + sequence grouping (US-1540).
  sourceName?: string;
  // Snapshot of the pre-processed image so one-tap enhancement/background removal
  // can be reverted. Present only after processing; cleared on undo/revert.
  original?: {
    url: string;
    storagePath: string;
    thumbnailUrl: string | null;
    thumbnailStoragePath: string | null;
    width: number | null;
    height: number | null;
    bytes: number;
    phash: string;
  };
}

// US-539: per-file upload pipeline state. Tasks drive the per-file progress
// bars while a batch is in flight; failed tasks keep their File so "Retry"
// can re-run the pipeline without re-picking. `retryable: false` marks
// permanent rejections (low-res, wrong type, corrupt) where retrying is
// pointless — those get only a dismiss affordance.
export type UploadTaskStatus =
  | "queued"
  | "processing"
  | "uploading"
  | "done"
  | "error";

export interface UploadTask {
  id: string;
  name: string;
  status: UploadTaskStatus;
  // 0–100. Stage-based through processing; REAL byte progress while uploading
  // (US-1542 — mapped onto 30..100 so a stall is visibly a stall).
  progress: number;
  error?: string;
  retryable?: boolean;
  file: File;
}

export interface StagedUploadResult {
  storagePath: string;
  url: string;
  thumbnailStoragePath: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

// Aggregate per-batch accounting for the summary toasts.
interface BatchStats {
  ok: number;
  failed: number;
  heicFailed: number;
  videoFailed: number;
  duplicates: number;
  borderline: string[];
}

// ── Constants (moved from autolister.tsx) ───────────────────────────

export const MIN_RESOLUTION = 1200;
export const BORDERLINE_RESOLUTION = 1500;

// Pipeline concurrency: compression is bounded by the worker pool (2–4
// workers), so lanes above that overlap network uploads with compression.
const UPLOAD_CONCURRENCY = 5;

// US-1542 AC3: how many files were in flight when the tab was closed/reloaded
// — Files can't survive an unload, so the page reads this on mount and tells
// the user how many need re-adding.
const LOST_UPLOADS_KEY = "autolister:lostUploads";

// ── Small helpers (moved from autolister.tsx) ───────────────────────

// Duplicate-upload guards: the cheap file identity used to skip re-picked
// files before any work happens, and a content hash that also catches the
// same image under a different name/mtime (e.g. "IMG_1 copy.jpg").
export function fileSig(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extForBlobType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

// ── Upload transport (US-1542: XHR for real byte progress) ──────────

// US-1541: pace upload STARTS under the edge's 120/60s staging-upload budget
// (with headroom for retries/another tab). Module-level so every lane — and a
// retry pass — shares the same window.
const uploadLimiter = new SlidingWindowLimiter();

interface XhrOutcome {
  status: number;
  responseText: string;
  retryAfter: string | null;
}

function xhrSend(
  sessionId: string,
  full: Blob,
  thumb: Blob | null,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): Promise<XhrOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${edgeApiUrl()}/api/flipdesk/autolister/staging/upload`);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    // A request on a half-open connection can hang indefinitely, freezing an
    // upload lane (and eventually the whole batch) with no error. Cap it —
    // the pipeline's catch marks the task retryable.
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        responseText: xhr.responseText,
        retryAfter: xhr.getResponseHeader("Retry-After"),
      });
    xhr.onerror = () =>
      reject(new Error("Upload failed — check your connection and retry."));
    xhr.ontimeout = () =>
      reject(new Error("Upload timed out — check your connection and retry."));
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("full", full, `photo.${extForBlobType(full.type)}`);
    if (thumb) form.append("thumb", thumb, `thumb.${extForBlobType(thumb.type)}`);
    // No explicit Content-Type — XHR sets the multipart boundary itself.
    xhr.send(form);
  });
}

/**
 * One validated staging upload with REAL byte-level progress (US-1542 AC4 —
 * the old fetch() path could only report stage checkpoints). Handles the
 * edgeFetch conveniences this path needs: auth headers, one forced
 * token-refresh retry on 401 (US-1146 parity), and 429 → RateLimitedError so
 * the paced wrapper backs off.
 */
async function xhrStagingUpload(
  sessionId: string,
  full: Blob,
  thumb: Blob | null,
  onProgress: (fraction: number) => void = () => {},
): Promise<StagedUploadResult> {
  // Content-Type must stay unset for FormData; edgeAuthHeaders(null) returns
  // Authorization + X-Workspace-Owner only.
  let headers = await edgeAuthHeaders(null);
  let outcome = await xhrSend(sessionId, full, thumb, headers, onProgress);

  if (outcome.status === 401) {
    const fresh = await forceRefreshAccessToken();
    if (fresh) {
      headers = { ...headers, Authorization: `Bearer ${fresh}` };
      outcome = await xhrSend(sessionId, full, thumb, headers, onProgress);
    }
  }
  // US-1541: a 429 is the server pacing us, not a per-file failure.
  if (outcome.status === 429) {
    const retryAfter = Number.parseInt(outcome.retryAfter ?? "", 10);
    throw new RateLimitedError(Number.isFinite(retryAfter) ? retryAfter : null);
  }

  let data: {
    error?: string;
    storage_path?: string;
    url?: string;
    thumbnail_storage_path?: string | null;
    thumbnail_url?: string | null;
    width?: number | null;
    height?: number | null;
    bytes?: number;
  } = {};
  try {
    data = JSON.parse(outcome.responseText) as typeof data;
  } catch {
    /* non-JSON body — handled below */
  }
  if (outcome.status < 200 || outcome.status >= 300 || !data.storage_path || !data.url) {
    throw new Error(data.error ?? `Upload failed (HTTP ${outcome.status})`);
  }
  return {
    storagePath: data.storage_path,
    url: data.url,
    thumbnailStoragePath: data.thumbnail_storage_path ?? null,
    thumbnailUrl: data.thumbnail_url ?? null,
    width: data.width ?? null,
    height: data.height ?? null,
    bytes: data.bytes ?? full.size,
  };
}

// Test seam (US-1542 AC6): unit tests replace the network transport so queue /
// retry / reattach semantics are testable without XHR or a live edge.
export const _transport = { upload: xhrStagingUpload };

/**
 * One paced, 429-aware upload (US-1541). Waits for a rate slot before each
 * attempt; on a 429 backs off (server Retry-After when given, else
 * exponential, always jittered) and retries in place. Exported for the
 * page's single-photo re-stage paths (photo editor, background clean) so
 * they share the same transport + pacing.
 */
export async function uploadStagingPhoto(
  session: string,
  full: Blob,
  thumb: Blob | null,
  onProgress: (fraction: number) => void = () => {},
): Promise<StagedUploadResult> {
  for (let attempt = 0; ; attempt++) {
    const delay = uploadLimiter.acquireDelayMs();
    if (delay > 0) await sleep(delay);
    try {
      return await _transport.upload(session, full, thumb, onProgress);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        if (attempt < RATE_LIMIT_MAX_ATTEMPTS - 1) {
          await sleep(backoffDelayMs(attempt, err.retryAfterSeconds));
          continue;
        }
        // Retries exhausted — keep it retryable with honest copy.
        throw new Error(
          "The server is rate-limiting uploads — wait a minute, then tap Retry failed.",
        );
      }
      throw err;
    }
  }
}

// ── Duplicate-identity bookkeeping (module-level, non-reactive) ─────

// `stagedSigs/Hashes` mirror the page's staged photos (replaced wholesale by
// syncStagedIdentities). `pipelineSigs/Hashes` are the in-flight + succeeded
// claims this store manages itself; a claim is released on failure, and a
// succeeded claim is superseded once the page's staged sync covers it.
const stagedSigs = new Set<string>();
const stagedHashes = new Set<string>();
const pipelineSigs = new Set<string>();
const pipelineHashes = new Set<string>();

function isKnownSig(sig: string): boolean {
  return stagedSigs.has(sig) || pipelineSigs.has(sig);
}
function isKnownHash(hash: string): boolean {
  return stagedHashes.has(hash) || pipelineHashes.has(hash);
}

// ── Store ───────────────────────────────────────────────────────────

interface AutolisterUploadState {
  /** Staging session the current tasks/results belong to. */
  sessionId: string | null;
  /** True while the intake page is mounted (it renders progress + claims results). */
  attached: boolean;
  tasks: UploadTask[];
  /** Finished staged photos not yet claimed by the page. */
  results: StagedPhoto[];

  /** Page lifecycle: mount/unmount. Attach adopts the session when idle. */
  attach: (sessionId: string) => void;
  detach: () => void;
  /** Replace the staged-photo identity sets used for duplicate detection. */
  syncStagedIdentities: (sigs: Set<string>, hashes: Set<string>) => void;
  /** Stage a batch of picked files. Resolves when the whole batch settles. */
  enqueueFiles: (files: File[], sessionId: string) => Promise<void>;
  /** US-1905: after a reload, re-run uploads persisted to IndexedDB. */
  resumeUploads: (sessionId: string) => Promise<void>;
  /** Re-run failed pipelines without re-picking files. */
  retryTasks: (taskIds: string[]) => Promise<void>;
  dismissTask: (id: string) => void;
  clearTasks: () => void;
  /** The page took these results into its staged state. */
  claimResults: (ids: string[]) => void;
  /** Files lost to the last hard unload (AC3); clears the marker. */
  consumeLostUploadCount: () => number;
}

function activeCount(tasks: UploadTask[]): number {
  return tasks.filter(
    (t) => t.status === "queued" || t.status === "processing" || t.status === "uploading",
  ).length;
}

export const useAutolisterUploadStore = create<AutolisterUploadState>((set, get) => {
  function patchTask(id: string, patch: Partial<UploadTask>) {
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }

  function removeTask(id: string) {
    set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
  }

  // Deliver one finished photo: into `results` for the page to claim, and —
  // while the page is detached — merged straight into the persisted session so
  // a hard reload while browsing elsewhere can't lose it (the page rehydrates
  // staged photos from that key on mount and the claim path dedupes by id).
  function deliverResult(photo: StagedPhoto) {
    set((state) => ({ results: [...state.results, photo] }));
    const { attached, sessionId } = get();
    if (!attached && sessionId) mergeIntoPersistedSession(sessionId, photo);
  }

  // US-539: the per-file pipeline. Capture time → HEIC transcode → off-thread
  // compress+thumbnail (worker pool) → quality gate → paced upload with real
  // byte progress. Never throws: every failure lands on the task (with
  // retryability) + batch stats. Moved verbatim from autolister.tsx (US-1542)
  // apart from the store plumbing + byte-level progress.
  async function processUploadTask(task: UploadTask, stats: BatchStats): Promise<void> {
    const { id, file } = task;

    // Duplicate gate 1: exact file identity. enqueueFiles pre-filters too, but
    // this claim is the authoritative, race-safe one (two lanes can carry the
    // same file when batches overlap or a retry races a re-pick).
    const sig = fileSig(file);
    const skipDuplicate = () => {
      stats.duplicates++;
      removeTask(id);
    };
    if (isKnownSig(sig)) {
      skipDuplicate();
      return;
    }
    pipelineSigs.add(sig);

    let contentHash = "";
    let succeeded = false;
    patchTask(id, { status: "processing", progress: 10, error: undefined });
    try {
      // Duplicate gate 2: content hash of the original bytes — catches the
      // same image re-added under a different name or modified time.
      contentHash = await sha256Hex(file).catch(() => "");
      if (contentHash && isKnownHash(contentHash)) {
        skipDuplicate();
        return;
      }
      if (contentHash) pipelineHashes.add(contentHash);
      // US-532: capture EXIF time from the ORIGINAL file (incl. HEIC) before
      // any transcode/recompression that may drop the metadata — it drives
      // capture-time auto-grouping.
      const capturedAt = await readCaptureTime(file).catch(() => null);
      // US-531 / US-1300: normalize odd iPhone inputs in the browser so they
      // "just work" instead of being rejected — a Live Photo exported as a
      // .mov/.mp4 video becomes a still JPEG frame, HEIC/HEIF becomes JPEG, and
      // ordinary JPEG/PNG/WebP pass through untouched.
      let workFile: File;
      try {
        workFile = await normalizeToImageFile(file);
      } catch (convErr) {
        if (import.meta.env.DEV) console.warn("[autolister] media intake failed:", convErr);
        const kind = convErr instanceof MediaIntakeError ? convErr.kind : "heic";
        if (kind === "video") stats.videoFailed++;
        else stats.heicFailed++;
        stats.failed++;
        patchTask(id, {
          status: "error",
          retryable: false,
          error: convErr instanceof Error
            ? convErr.message
            : "Couldn't convert this file. Re-export it as a JPEG and add it again.",
        });
        return;
      }
      // US-540: type gate (the compressor and server accept JPEG/PNG/WebP).
      if (!/^image\/(jpeg|png|webp)$/.test(workFile.type)) {
        stats.failed++;
        patchTask(id, {
          status: "error",
          retryable: false,
          error: `Unsupported type "${workFile.type || "unknown"}" — use JPEG, PNG, or WebP.`,
        });
        return;
      }
      patchTask(id, { progress: 25 });

      let body: Blob = workFile;
      let width: number | null = null;
      let height: number | null = null;
      let phash = "";
      let thumbBlob: Blob | null = null;
      let compressed = false;
      try {
        // US-539: decode + resize + thumbnail + dHash run in the worker pool
        // (OffscreenCanvas), one decode for both renditions, off the main thread.
        const out = await processStagedImage(workFile, {
          maxWidth: 2400,
          quality: 0.85,
          thumbWidth: 320,
          thumbQuality: 0.7,
        });
        // US-540: gate on minimum resolution (original dimensions) BEFORE we
        // spend an upload + AI generation on an image too small to list well.
        // Borderline (just above the floor) images warn but still pass.
        if (out.srcWidth != null && out.srcHeight != null) {
          const minDim = Math.min(out.srcWidth, out.srcHeight);
          if (minDim < MIN_RESOLUTION) {
            stats.failed++;
            patchTask(id, {
              status: "error",
              retryable: false,
              error: `Resolution (${out.srcWidth}x${out.srcHeight}) is too low. Minimum is ${MIN_RESOLUTION}x${MIN_RESOLUTION}px.`,
            });
            return;
          }
          if (minDim < BORDERLINE_RESOLUTION) stats.borderline.push(file.name);
        }
        body = out.blob;
        width = out.width;
        height = out.height;
        phash = out.phash; // US-532: dHash for the visual grouping pass
        thumbBlob = out.thumbBlob;
        compressed = true;
      } catch (compErr) {
        if (compErr instanceof ImageDecodeError) {
          stats.failed++;
          patchTask(id, { status: "error", retryable: false, error: compErr.message });
          return;
        }
        if (import.meta.env.DEV) console.warn("[autolister] compress failed, using original:", compErr);
      }
      // If compression failed AND the file is huge (>15MB), the AI generation
      // will likely choke too. Skip with a clear message.
      if (!compressed && workFile.size > 15 * 1024 * 1024) {
        stats.failed++;
        patchTask(id, {
          status: "error",
          retryable: false,
          error: `${(workFile.size / 1024 / 1024).toFixed(1)}MB and couldn't be compressed in the browser. Convert it to a regular JPEG and try again.`,
        });
        return;
      }

      // US-529: server-side validated upload (sniff + caps + EXIF strip). On
      // the compress-failure fallback `body` is the raw original — the
      // server's metadata strip guarantees no GPS EXIF lands in storage.
      // US-1541: paced under the server's rate budget + auto-backoff on 429.
      // US-1542: progress 30→100 is REAL byte progress, throttled to whole
      // steps so a 600-file batch doesn't storm the store with set() calls.
      patchTask(id, { status: "uploading", progress: 30 });
      let lastPct = 30;
      const sessionForUpload = get().sessionId ?? "";
      const up = await uploadStagingPhoto(sessionForUpload, body, thumbBlob, (fraction) => {
        const pct = 30 + Math.round(fraction * 70);
        if (pct >= lastPct + 2 || pct === 100) {
          lastPct = pct;
          patchTask(id, { progress: pct });
        }
      });

      deliverResult({
        id: crypto.randomUUID(),
        url: up.url,
        storagePath: up.storagePath,
        thumbnailUrl: up.thumbnailUrl,
        thumbnailStoragePath: up.thumbnailStoragePath,
        width: width ?? up.width,
        height: height ?? up.height,
        bytes: up.bytes,
        capturedAtMs: capturedAt ? capturedAt.getTime() : null,
        phash,
        sourceSig: sig,
        sourceHash: contentHash || undefined,
        sourceName: file.name,
      });
      succeeded = true;
      stats.ok++;
      patchTask(id, { status: "done", progress: 100 });
    } catch (err) {
      // Transient failures (network, server hiccup) — keep the File for retry.
      stats.failed++;
      patchTask(id, {
        status: "error",
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // US-1905: the persisted resume blob is no longer needed once the upload
      // succeeds, or once it fails un-retryably (re-running it would only fail
      // again). A retryable failure keeps its blob so a reload can resume it.
      if (succeeded) {
        void deleteBlob(id);
      } else {
        const current = get().tasks.find((t) => t.id === id);
        if (current?.status === "error" && current.retryable === false) {
          void deleteBlob(id);
        }
        // Free the duplicate claims unless the photo actually staged (then the
        // staged-derived set takes over) — a failed/rejected file must remain
        // re-addable after a retry or dismiss.
        pipelineSigs.delete(sig);
        if (contentHash) pipelineHashes.delete(contentHash);
      }
    }
  }

  return {
    sessionId: null,
    attached: false,
    tasks: [],
    results: [],

    attach: (sessionId) => {
      const state = get();
      // A different session with nothing in flight = a fresh start (the old
      // session was generated/cleared). Drop any stale leftovers.
      if (state.sessionId !== sessionId && activeCount(state.tasks) === 0) {
        pipelineSigs.clear();
        pipelineHashes.clear();
        set({ sessionId, attached: true, tasks: [], results: [] });
        return;
      }
      set({ sessionId: state.sessionId ?? sessionId, attached: true });
    },

    detach: () => set({ attached: false }),

    syncStagedIdentities: (sigs, hashes) => {
      stagedSigs.clear();
      stagedHashes.clear();
      for (const s of sigs) stagedSigs.add(s);
      for (const h of hashes) stagedHashes.add(h);
      // The staged-derived sets take over for anything they now cover.
      for (const s of sigs) pipelineSigs.delete(s);
      for (const h of hashes) pipelineHashes.delete(h);
    },

    // US-539: stage a batch. Each file runs the full pipeline in its own lane
    // (UPLOAD_CONCURRENCY at a time), so compression (worker pool) and uploads
    // overlap instead of running serially; photos appear as each finishes.
    // Settled "done" rows are swept once the batch ends; failures stay for
    // retry/dismiss.
    enqueueFiles: async (files, sessionId) => {
      if (files.length === 0) return;
      const state = get();
      if (state.sessionId !== sessionId) {
        // New session (first batch, or the previous session was generated
        // away while idle). In-flight tasks for another session shouldn't
        // exist — batches are only enqueued from the mounted page.
        pipelineSigs.clear();
        pipelineHashes.clear();
        set({ sessionId, results: activeCount(state.tasks) > 0 ? state.results : [] });
      }

      // Skip files that are already staged (or picked twice in this drop) up
      // front, so re-dropping the same folder doesn't even enqueue them. The
      // pipeline re-checks under its race-safe claim; this is just the fast path.
      const seenSigs = new Set<string>();
      const stats: BatchStats = {
        ok: 0, failed: 0, heicFailed: 0, videoFailed: 0, duplicates: 0, borderline: [],
      };
      const fresh = files.filter((file) => {
        const sig = fileSig(file);
        if (seenSigs.has(sig) || isKnownSig(sig)) {
          stats.duplicates++;
          return false;
        }
        seenSigs.add(sig);
        return true;
      });
      if (fresh.length === 0) {
        reportBatch(stats);
        return;
      }
      const tasks: UploadTask[] = fresh.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        status: "queued",
        progress: 0,
        file,
      }));
      set((s) => ({ tasks: [...s.tasks.filter((t) => t.status !== "done"), ...tasks] }));
      // US-1905: persist each queued file up front so a reload/crash can resume
      // the upload instead of losing it. Fire-and-forget — never blocks intake.
      const persistBase = Date.now();
      tasks.forEach((t, i) => {
        void putBlob({
          taskId: t.id,
          sessionId,
          sig: fileSig(t.file),
          name: t.file.name,
          type: t.file.type,
          blob: t.file,
          createdAt: persistBase + i,
        });
      });
      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY, (t) => processUploadTask(t, stats));
      reportBatch(stats);
      set((s) => ({ tasks: s.tasks.filter((t) => t.status !== "done") }));
    },

    // US-1905: resume uploads whose original blobs were persisted to IDB but
    // never finished (a reload/crash mid-batch). Reuses each blob's task id so
    // the on-success deleteBlob still matches. Already-staged files (the page
    // synced their sigs on mount) are skipped; the pipeline re-checks too.
    resumeUploads: async (sessionId) => {
      if (!idbAvailable()) return;
      let blobs: Awaited<ReturnType<typeof listBlobs>>;
      try {
        blobs = await listBlobs(sessionId);
      } catch {
        return;
      }
      if (blobs.length === 0) return;
      const tasks: UploadTask[] = blobs
        .filter((b) => !isKnownSig(b.sig))
        .map((b) => ({
          id: b.taskId,
          name: b.name,
          status: "queued",
          progress: 0,
          // Rebuild a File from the stored bytes + original name/type (don't
          // trust structured clone to preserve the File subtype/MIME).
          file: new File([b.blob], b.name, { type: b.type }),
        }));
      if (tasks.length === 0) return;
      const state = get();
      set({
        sessionId,
        tasks: [...state.tasks.filter((t) => t.status !== "done"), ...tasks],
      });
      const stats: BatchStats = {
        ok: 0, failed: 0, heicFailed: 0, videoFailed: 0, duplicates: 0, borderline: [],
      };
      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY, (t) => processUploadTask(t, stats));
      reportBatch(stats);
      set((s) => ({ tasks: s.tasks.filter((t) => t.status !== "done") }));
    },

    retryTasks: async (taskIds) => {
      const targets = get().tasks.filter(
        (t) => taskIds.includes(t.id) && t.status === "error" && t.retryable !== false,
      );
      if (targets.length === 0) return;
      const stats: BatchStats = {
        ok: 0, failed: 0, heicFailed: 0, videoFailed: 0, duplicates: 0, borderline: [],
      };
      await runWithConcurrency(targets, UPLOAD_CONCURRENCY, (t) => processUploadTask(t, stats));
      reportBatch(stats);
      set((s) => ({ tasks: s.tasks.filter((t) => t.status !== "done") }));
    },

    dismissTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

    clearTasks: () => set({ tasks: [] }),

    claimResults: (ids) => {
      const idSet = new Set(ids);
      set((s) => ({ results: s.results.filter((r) => !idSet.has(r.id)) }));
    },

    consumeLostUploadCount: () => {
      if (typeof window === "undefined") return 0;
      // Only meaningful when the store itself is fresh (a real reload). On an
      // in-app return the tasks are still here — nothing was lost.
      if (get().tasks.length > 0) return 0;
      const raw = window.localStorage.getItem(LOST_UPLOADS_KEY);
      window.localStorage.removeItem(LOST_UPLOADS_KEY);
      const count = Number.parseInt(raw ?? "", 10);
      return Number.isFinite(count) && count > 0 ? count : 0;
    },
  };
});

// ── Batch summary toasts (moved from autolister.tsx) ────────────────
// Fired from the store so a batch that finishes while the user is on another
// page still reports — the sonner Toaster is app-level.

function reportBatch(stats: BatchStats) {
  if (stats.ok > 0) {
    toast.success(`${stats.ok} photo${stats.ok === 1 ? "" : "s"} added.`);
  }
  if (stats.duplicates > 0) {
    toast.info(
      `${stats.duplicates} duplicate photo${stats.duplicates === 1 ? "" : "s"} skipped.`,
      { description: "They're already staged — nothing was added twice." },
    );
  }
  if (stats.heicFailed > 0) {
    toast.warning(
      `${stats.heicFailed} HEIC photo${stats.heicFailed === 1 ? "" : "s"} couldn't be converted.`,
      {
        description:
          "Re-export them as JPEG (Photos app → Share → Save as Files → JPEG) and try again.",
        duration: 8_000,
      },
    );
  }
  if (stats.videoFailed > 0) {
    toast.warning(
      `${stats.videoFailed} Live Photo / video${stats.videoFailed === 1 ? "" : "s"} couldn't be converted.`,
      {
        description:
          "Open it in Photos, save a still (Share → Save as Current Photo / a frame), and add that JPEG.",
        duration: 8_000,
      },
    );
  }
  const otherFailed = stats.failed - stats.heicFailed - stats.videoFailed;
  if (otherFailed > 0) {
    toast.error(
      `${otherFailed} photo${otherFailed === 1 ? "" : "s"} didn't make it.`,
      {
        description:
          "Each one is listed on the AutoLister page with the reason — retry or dismiss.",
        duration: 8_000,
      },
    );
  }
  if (stats.borderline.length > 0) {
    toast.warning(
      `${stats.borderline.length} photo${stats.borderline.length === 1 ? "" : "s"} are low-resolution.`,
      {
        description:
          "They'll list, but a sharper, larger shot (1500px+) reads better and sells faster.",
        duration: 8_000,
      },
    );
  }
}

// ── Detached-result persistence (US-1542) ───────────────────────────

/**
 * Merge one finished photo into the persisted intake session, deduped by id.
 * Called only while the page is detached, so it never races the page's own
 * persist effect. US-1905: written to BOTH IndexedDB (the page's authoritative
 * store, atomic append) and the localStorage mirror; a reload rehydrates from
 * whichever the page uses. Best-effort: on failure the photo is still in
 * `results` for the page to claim on its next mount.
 */
function mergeIntoPersistedSession(sessionId: string, photo: StagedPhoto): void {
  if (typeof window === "undefined") return;
  // US-1905: land the detached-completed photo in IndexedDB too, so the page's
  // IDB rehydrate (which ignores localStorage when an IDB session exists) sees
  // it. Atomic get→put, deduped by id; fire-and-forget.
  void appendStagedToSession(sessionId, photo as unknown as { id: string } & Record<string, unknown>);
  const key = `autolister:state:${sessionId}`;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw
      ? (JSON.parse(raw) as { staged?: StagedPhoto[]; groups?: unknown })
      : {};
    const staged = Array.isArray(parsed.staged) ? parsed.staged : [];
    if (staged.some((p) => p.id === photo.id)) return;
    staged.push(photo);
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...parsed, staged }),
    );
  } catch {
    /* quota/disabled storage — the in-memory `results` copy still covers it */
  }
}

// ── Unload guards (US-1542 AC3) ─────────────────────────────────────

if (typeof window !== "undefined") {
  // Keep the lost-uploads marker current: any task that isn't `done` holds a
  // File that cannot survive a full unload. Written on every task change so
  // the count is accurate whenever the unload actually happens.
  useAutolisterUploadStore.subscribe((state) => {
    try {
      // US-1905: when IndexedDB is available, unfinished uploads were persisted
      // and resume after a reload — so they are NOT lost. Only the localStorage
      // fallback (no IDB) genuinely loses in-flight Files.
      const atRisk = idbAvailable()
        ? 0
        : state.tasks.filter((t) => t.status !== "done").length;
      if (atRisk > 0) {
        window.localStorage.setItem(LOST_UPLOADS_KEY, String(atRisk));
      } else {
        window.localStorage.removeItem(LOST_UPLOADS_KEY);
      }
    } catch {
      /* best-effort */
    }
  });

  // Full page close/reload is the one thing the web platform cannot survive —
  // warn while anything is in flight. US-1905: with IndexedDB the queued blobs
  // resume automatically, so the warning is downgraded away in that case; it
  // only fires on the localStorage fallback where in-flight Files are lost.
  window.addEventListener("beforeunload", (event) => {
    const inFlight = activeCount(useAutolisterUploadStore.getState().tasks);
    if (inFlight > 0 && !idbAvailable()) {
      event.preventDefault();
      // Chrome requires returnValue to be set for the prompt to appear.
      event.returnValue = "";
    }
  });
}
