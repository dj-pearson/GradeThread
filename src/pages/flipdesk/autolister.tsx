import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  Loader2,
  Sparkles,
  Trash2,
  Plus,
  Star,
  X,
  ImageIcon,
  Combine,
  Wand2,
  FolderOpen,
  Images,
  Tags,
  WandSparkles,
  Eraser,
  Undo2,
  Pencil,
  RotateCcw,
  Camera,
  ArrowDownAZ,
} from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { itemPhotoThumb } from "@/lib/images";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { ImageDecodeError, processStagedImage } from "@/lib/image-worker-pool";
import { runWithConcurrency } from "@/lib/concurrency";
import { readCaptureTime } from "@/lib/exif";
import {
  isVideoFile,
  MediaIntakeError,
  normalizeToImageFile,
} from "@/lib/media-intake";
import { autoGroupPhotos, type GroupablePhoto } from "@/lib/autolister-grouping";
import { autoEnhance, type EnhanceStats } from "@/lib/image-enhance";
import { removeImageBackground, type BgMode } from "@/lib/background-removal";
import { useStartAutolisterBatch, useRunCoverQa } from "@/hooks/use-autolister";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// FlipDesk AutoLister (US-316 upload + US-317 grouping). Dump a folder of
// photos, group them so each group = one item/listing, then Generate — which
// materializes each group into an inventory item + photos and kicks off the
// batch AI generation (US-313 backend), landing on the queue view (US-318).
//
// Generation is metered + premium-gated server-side (US-323). The quota/tier
// gate surfaces through edgeFetch's 402 handling, so we don't duplicate it here.

interface StagedPhoto {
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
  // Original filename, for the name sort (photos shot as IMG_0001..IMG_0600
  // regroup correctly even when retries appended them out of order).
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

// US-533: per-photo gallery roles. The cover is always "front"; the rest carry
// a role the AI assigns (and the user can override). Order after the cover:
// back → tag → detail → defect.
type PhotoRole = "front" | "back" | "tag" | "detail" | "defect";
const ROLE_ORDER: Record<PhotoRole, number> = {
  front: 0,
  back: 1,
  tag: 2,
  detail: 3,
  defect: 4,
};

interface Group {
  id: string;
  name: string;
  // The seller's own inventory SKU / listing number. When it matches an
  // existing inventory item, the photo group binds to that item (instead of
  // creating a duplicate) so the AI draft can be reconciled against the
  // sheet-imported record field-by-field. Optional → round-trips older sessions.
  sku?: string;
  photoIds: string[];
  coverId: string;
  // photoId -> role. Optional so sessions persisted before US-533 (and freshly
  // created groups) round-trip; a missing entry falls back to "detail".
  roles?: Record<string, PhotoRole>;
}

function extForBlobType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

// US-529: every staged upload goes through the edge's validated path
// (magic-byte sniff, size/dimension caps, min-resolution gate, EXIF/GPS strip
// — the US-276 hardening) instead of writing to storage directly from the
// browser. This also covers the compress-failure fallback: the server strips
// metadata, so a raw original never lands with GPS intact.
interface StagedUploadResult {
  storagePath: string;
  url: string;
  thumbnailStoragePath: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

async function uploadStagingPhoto(
  session: string,
  full: Blob,
  thumb: Blob | null,
): Promise<StagedUploadResult> {
  const form = new FormData();
  form.append("session_id", session);
  form.append("full", full, `photo.${extForBlobType(full.type)}`);
  if (thumb) {
    form.append("thumb", thumb, `thumb.${extForBlobType(thumb.type)}`);
  }
  // A fetch on a half-open connection can hang indefinitely, freezing an
  // upload lane (and eventually the whole batch) with no error. Cap it —
  // the pipeline's catch marks the task retryable.
  let res: Response;
  try {
    res = await edgeFetch("/api/flipdesk/autolister/staging/upload", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error("Upload timed out — check your connection and retry.");
    }
    throw err;
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    storage_path?: string;
    url?: string;
    thumbnail_storage_path?: string | null;
    thumbnail_url?: string | null;
    width?: number | null;
    height?: number | null;
    bytes?: number;
  };
  if (!res.ok || !data.storage_path || !data.url) {
    throw new Error(data.error ?? `Upload failed (HTTP ${res.status})`);
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

// US-539: per-file upload pipeline state. Tasks drive the per-file progress
// bars while a batch is in flight; failed tasks keep their File so "Retry"
// can re-run the pipeline without re-picking. `retryable: false` marks
// permanent rejections (low-res, wrong type, corrupt) where retrying is
// pointless — those get only a dismiss affordance.
type UploadTaskStatus = "queued" | "processing" | "uploading" | "done" | "error";

interface UploadTask {
  id: string;
  name: string;
  status: UploadTaskStatus;
  progress: number; // 0–100, stage-based
  error?: string;
  retryable?: boolean;
  file: File;
}

// Pipeline concurrency: compression is bounded by the worker pool (2–4
// workers), so lanes above that overlap network uploads with compression.
const UPLOAD_CONCURRENCY = 5;

// Aggregate per-batch accounting for the summary toasts.
interface BatchStats {
  ok: number;
  failed: number;
  heicFailed: number;
  videoFailed: number;
  duplicates: number;
  borderline: string[];
}

// Duplicate-upload guards: the cheap file identity used to skip re-picked
// files before any work happens, and a content hash that also catches the
// same image under a different name/mtime (e.g. "IMG_1 copy.jpg").
function fileSig(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Sort key for the name sort. Pre-sourceName photos recover the filename from
// sourceSig (`name|size|mtime` — name may itself contain "|", so strip the
// two known trailing segments). null = no name known (e.g. Google imports).
function stagedSortName(p: StagedPhoto): string | null {
  if (p.sourceName) return p.sourceName;
  if (p.sourceSig) {
    const parts = p.sourceSig.split("|");
    if (parts.length >= 3) return parts.slice(0, -2).join("|");
  }
  return null;
}

// Staging thumbnails on a big batch (600 photos) arrive as one HTTP/2 burst
// that the self-hosted storage backend can 504 under. Retry each failed image
// a few times with jittered backoff (cache-busting param so the browser and
// any intermediary actually refetch) instead of leaving broken tiles.
function StagedThumb({ src, className }: { src: string; className?: string }) {
  const [attempt, setAttempt] = useState(0);
  const url =
    attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={className}
      onError={() => {
        if (attempt < 5) {
          const delay = 1_000 * 2 ** attempt + Math.random() * 1_500;
          setTimeout(() => setAttempt((a) => a + 1), delay);
        }
      }}
    />
  );
}

const MIN_RESOLUTION = 1200;
const BORDERLINE_RESOLUTION = 1500;

// US-957: covers scoring below this (0-100 listing-readiness) get a non-blocking
// "reshoot recommended" nudge before Generate. Advisory only — never blocks.
const COVER_QA_REVIEW_THRESHOLD = 60;

// US-530: collect Files from a drag-and-drop, recursing into dropped FOLDERS
// (webkitGetAsEntry). Falls back to the flat file list when the entries API
// isn't available.
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (roots.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = () =>
        new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const e of batch) await walk(e);
        batch = await readBatch(); // readEntries pages; loop until empty
      }
    }
  }
  for (const e of roots) await walk(e);
  return out;
}

export function FlipdeskAutolisterPage() {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const ownerId = workspaceOwnerId ?? user?.id ?? null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const startBatch = useStartAutolisterBatch();
  const coverQa = useRunCoverQa();

  const { data: billing, isLoading: billingLoading } = useBillingSummary();
  const plan = billing?.subscription.plan ?? "free";
  const entitled = FLIPDESK_PLANS[plan].gateFlags.autolister;

  // US-317: persist sessionId across reloads so the _staging uploads aren't
  // orphaned and the staged/groups state can be rehydrated.
  const sessionId = useRef<string>(
    (() => {
      const existing = typeof window !== "undefined"
        ? window.localStorage.getItem("autolister:sessionId")
        : null;
      if (existing) return existing;
      const id = crypto.randomUUID();
      if (typeof window !== "undefined") {
        window.localStorage.setItem("autolister:sessionId", id);
      }
      return id;
    })(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const storageKey = `autolister:state:${sessionId.current}`;
  // Lazy-rehydrate staged/groups from localStorage so a refresh recovers the
  // in-flight session. Uploaded photos live in Supabase Storage independently;
  // only the in-memory grouping state is at risk of loss.
  const [staged, setStaged] = useState<StagedPhoto[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { staged?: StagedPhoto[] };
      return Array.isArray(parsed.staged) ? parsed.staged : [];
    } catch {
      return [];
    }
  });
  const [groups, setGroups] = useState<Group[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { groups?: Group[] };
      return Array.isArray(parsed.groups) ? parsed.groups : [];
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  // US-539: per-file pipeline tasks (progress bars + failure retry).
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const uploading = uploadTasks.filter(
    (t) => t.status === "queued" || t.status === "processing" || t.status === "uploading",
  ).length;
  const [busy, setBusy] = useState(false);
  // US-955: fire-and-forget — auto-publish the green, clean drafts on completion.
  const [autoPublishGreen, setAutoPublishGreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Google Photos import: whether the server has it configured, and an
  // in-flight flag while the user picks photos in the Google popup.
  const [gpConfigured, setGpConfigured] = useState(false);
  const [gpImporting, setGpImporting] = useState(false);

  // One-time check whether Google Photos import is configured server-side, so
  // we only show the button when it'll actually work.
  useEffect(() => {
    if (!entitled) return;
    let cancelled = false;
    void edgeFetch("/api/flipdesk/google/photos/config")
      .then((r) => r.json())
      .then((j: { configured?: boolean }) => {
        if (!cancelled) setGpConfigured(!!j.configured);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entitled]);

  // US-533: groups currently running the AI cover/role pass.
  const [taggingGroups, setTaggingGroups] = useState<Set<string>>(new Set());
  const [taggingAll, setTaggingAll] = useState(false);
  // US-535: studio background. Mode for the one-tap clean, photos currently
  // being segmented, a batch-busy flag, and one-time model-download progress.
  const [bgMode, setBgMode] = useState<BgMode>("white");
  const [bgProcessing, setBgProcessing] = useState<Set<string>>(new Set());
  const [bgBusy, setBgBusy] = useState(false);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  // US-536: photos currently being auto-enhanced, and a batch-busy flag.
  const [enhancing, setEnhancing] = useState<Set<string>>(new Set());
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  // US-534: id of the staged photo open in the crop/rotate/straighten editor.
  const [editingPhotoId, setEditingPhotoId] = useState<string | null>(null);
  // US-957: fast cover-photo QA scores, keyed by the cover staged-photo id
  // (0-100, or -1 on error). A ref tracks covers whose scan is in flight so the
  // scanning effect never double-submits the same cover.
  const [coverScores, setCoverScores] = useState<Record<string, number>>({});
  const coverInFlight = useRef<Set<string>>(new Set());

  // Duplicate guards. `stagedDedup` mirrors the staged photos' source
  // signatures/hashes (rebuilt below, so deleting a photo frees its identity
  // for re-adding). `inflightDedup` holds claims for tasks mid-pipeline —
  // released on failure, and transferred to the staged set on success (the
  // rebuild prunes claims that made it into `staged`).
  const stagedDedup = useRef<{ sigs: Set<string>; hashes: Set<string> }>({
    sigs: new Set(),
    hashes: new Set(),
  });
  const inflightDedup = useRef<{ sigs: Set<string>; hashes: Set<string> }>({
    sigs: new Set(),
    hashes: new Set(),
  });
  useEffect(() => {
    const sigs = new Set<string>();
    const hashes = new Set<string>();
    for (const p of staged) {
      if (p.sourceSig) sigs.add(p.sourceSig);
      if (p.sourceHash) hashes.add(p.sourceHash);
    }
    stagedDedup.current = { sigs, hashes };
    for (const s of sigs) inflightDedup.current.sigs.delete(s);
    for (const h of hashes) inflightDedup.current.hashes.delete(h);
  }, [staged]);

  // Persist whenever staged / groups change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ staged, groups }),
      );
    } catch {
      /* quota or disabled storage — best-effort */
    }
  }, [staged, groups, storageKey]);

  const stagedById = useMemo(
    () => new Map(staged.map((p) => [p.id, p])),
    [staged],
  );
  const groupedIds = useMemo(
    () => new Set(groups.flatMap((g) => g.photoIds)),
    [groups],
  );
  const ungrouped = staged.filter((p) => !groupedIds.has(p.id));

  // US-957: how many groups have a low-scoring cover (drives the advisory near
  // the Generate button). -1 (a QA error) is not counted as "low".
  const lowCoverCount = useMemo(
    () =>
      groups.filter((g) => {
        const s = coverScores[g.coverId];
        return s != null && s >= 0 && s < COVER_QA_REVIEW_THRESHOLD;
      }).length,
    [groups, coverScores],
  );

  // US-957: as photos get grouped, score each group's cover so a low-quality
  // cover can be reshot before the (much pricier) AI generation runs. Each pass
  // batches the not-yet-scored covers into a single request; the edge runs the
  // vision calls with bounded concurrency, so this never stalls the intake UI.
  // Advisory only — failures are swallowed and a score never blocks Generate.
  useEffect(() => {
    if (!entitled) return;
    const pending: { id: string; storage_path: string }[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      const cover = stagedById.get(g.coverId);
      if (!cover || seen.has(cover.id)) continue;
      seen.add(cover.id);
      if (cover.id in coverScores) continue;
      if (coverInFlight.current.has(cover.id)) continue;
      pending.push({ id: cover.id, storage_path: cover.storagePath });
    }
    if (pending.length === 0) return;
    for (const p of pending) coverInFlight.current.add(p.id);
    coverQa.mutate(
      { covers: pending },
      {
        onSuccess: ({ results }) => {
          setCoverScores((prev) => {
            const next = { ...prev };
            for (const r of results) next[r.cover_id] = r.score;
            return next;
          });
        },
        onSettled: () => {
          for (const p of pending) coverInFlight.current.delete(p.id);
        },
      },
    );
    // coverQa.mutate is referentially stable (react-query); the deps below cover
    // every input the scan reads. Including `coverQa` itself would re-run every
    // render (useMutation returns a fresh object each time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, stagedById, coverScores, entitled]);

  function patchTask(id: string, patch: Partial<UploadTask>) {
    setUploadTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  // US-539: the per-file pipeline. Capture time → HEIC transcode → off-thread
  // compress+thumbnail (worker pool) → quality gate → parallel upload. Never
  // throws: every failure lands on the task (with retryability) + batch stats.
  async function processUploadTask(task: UploadTask, stats: BatchStats): Promise<void> {
    const { id, file } = task;

    // Duplicate gate 1: exact file identity. handleFiles pre-filters too, but
    // this claim is the authoritative, race-safe one (two lanes can carry the
    // same file when batches overlap or a retry races a re-pick).
    const sig = fileSig(file);
    const isDupSig = () =>
      stagedDedup.current.sigs.has(sig) || inflightDedup.current.sigs.has(sig);
    const skipDuplicate = () => {
      stats.duplicates++;
      setUploadTasks((prev) => prev.filter((t) => t.id !== id));
    };
    if (isDupSig()) {
      skipDuplicate();
      return;
    }
    inflightDedup.current.sigs.add(sig);

    let contentHash = "";
    let succeeded = false;
    patchTask(id, { status: "processing", progress: 10, error: undefined });
    try {
      // Duplicate gate 2: content hash of the original bytes — catches the
      // same image re-added under a different name or modified time.
      contentHash = await sha256Hex(file).catch(() => "");
      if (
        contentHash &&
        (stagedDedup.current.hashes.has(contentHash) ||
          inflightDedup.current.hashes.has(contentHash))
      ) {
        skipDuplicate();
        return;
      }
      if (contentHash) inflightDedup.current.hashes.add(contentHash);
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
      patchTask(id, { status: "uploading", progress: 65 });
      const up = await uploadStagingPhoto(sessionId.current, body, thumbBlob);

      setStaged((prev) => [
        ...prev,
        {
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
        },
      ]);
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
      // Free the duplicate claims unless the photo actually staged (then the
      // staged-derived set takes over) — a failed/rejected file must remain
      // re-addable after a retry or dismiss.
      if (!succeeded) {
        inflightDedup.current.sigs.delete(sig);
        if (contentHash) inflightDedup.current.hashes.delete(contentHash);
      }
    }
  }

  function reportBatch(stats: BatchStats) {
    if (stats.ok > 0) {
      toast.success(`${stats.ok} photo${stats.ok === 1 ? "" : "s"} added.`);
    }
    if (stats.duplicates > 0) {
      toast.info(
        `${stats.duplicates} duplicate photo${stats.duplicates === 1 ? "" : "s"} skipped.`,
        { description: "They're already staged below — nothing was added twice." },
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
          description: "Each one is listed above with the reason — retry or dismiss.",
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

  // US-539: stage a batch. Each file runs the full pipeline in its own lane
  // (UPLOAD_CONCURRENCY at a time), so compression (worker pool) and uploads
  // overlap instead of running serially; photos appear in the grid as each
  // finishes. Settled "done" rows are swept once the batch ends; failures stay
  // for retry/dismiss.
  async function handleFiles(files: FileList | File[] | null) {
    if (!files || !ownerId) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    // Skip files that are already staged (or picked twice in this drop) up
    // front, so re-dropping the same folder doesn't even enqueue them. The
    // pipeline re-checks under its race-safe claim; this is just the fast path.
    const seenSigs = new Set<string>();
    const stats: BatchStats = { ok: 0, failed: 0, heicFailed: 0, videoFailed: 0, duplicates: 0, borderline: [] };
    const fresh = list.filter((file) => {
      const sig = fileSig(file);
      if (
        seenSigs.has(sig) ||
        stagedDedup.current.sigs.has(sig) ||
        inflightDedup.current.sigs.has(sig)
      ) {
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
    setUploadTasks((prev) => [...prev.filter((t) => t.status !== "done"), ...tasks]);
    await runWithConcurrency(tasks, UPLOAD_CONCURRENCY, (t) => processUploadTask(t, stats));
    reportBatch(stats);
    setUploadTasks((prev) => prev.filter((t) => t.status !== "done"));
  }

  // US-539: re-run failed pipelines without re-picking files.
  async function retryUploadTasks(taskIds: string[]) {
    const targets = uploadTasks.filter(
      (t) => taskIds.includes(t.id) && t.status === "error" && t.retryable !== false,
    );
    if (targets.length === 0) return;
    const stats: BatchStats = { ok: 0, failed: 0, heicFailed: 0, videoFailed: 0, duplicates: 0, borderline: [] };
    await runWithConcurrency(targets, UPLOAD_CONCURRENCY, (t) => processUploadTask(t, stats));
    reportBatch(stats);
    setUploadTasks((prev) => prev.filter((t) => t.status !== "done"));
  }

  function dismissUploadTask(id: string) {
    setUploadTasks((prev) => prev.filter((t) => t.id !== id));
  }

  // Google Photos import: open the Google-hosted picker in a popup, poll
  // until the user finishes, then the edge downloads+validates the picks and
  // returns staged URLs (with capture time, so auto-grouping works on them).
  async function importFromGooglePhotos() {
    if (gpImporting || !ownerId) return;
    setGpImporting(true);
    let popup: Window | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      setGpImporting(false);
    };

    try {
      const startRes = await edgeFetch("/api/flipdesk/google/photos/oauth/start");
      if (startRes.status === 503) {
        toast.error("Google Photos import isn't configured yet.");
        setGpImporting(false);
        return;
      }
      const start = (await startRes.json()) as {
        session_id?: string;
        consent_url?: string;
        error?: string;
      };
      if (!startRes.ok || !start.session_id || !start.consent_url) {
        toast.error(start.error || "Could not start Google Photos import.");
        setGpImporting(false);
        return;
      }
      const sessionId = start.session_id;
      popup = window.open(start.consent_url, "gphotos", "width=620,height=760");
      if (!popup) {
        toast.error("Please allow popups to import from Google Photos.");
        setGpImporting(false);
        return;
      }
      toast.info("Pick your photos in the Google window — they'll appear here when you're done.", {
        duration: 8000,
      });

      const startedAt = Date.now();
      const doImport = async () => {
        const imp = await edgeFetch(
          `/api/flipdesk/google/photos/import?session=${sessionId}`,
          { method: "POST" },
        );
        const ij = (await imp.json()) as {
          photos?: Array<{
            url: string;
            storagePath: string;
            width: number | null;
            height: number | null;
            bytes: number;
            capturedAtMs: number | null;
          }>;
        };
        const added: StagedPhoto[] = (ij.photos ?? []).map((p) => ({
          id: crypto.randomUUID(),
          url: p.url,
          storagePath: p.storagePath,
          thumbnailUrl: null,
          thumbnailStoragePath: null,
          width: p.width,
          height: p.height,
          bytes: p.bytes,
          capturedAtMs: p.capturedAtMs,
          phash: "",
        }));
        if (added.length > 0) {
          setStaged((prev) => [...prev, ...added]);
          toast.success(
            `Imported ${added.length} photo${added.length === 1 ? "" : "s"} from Google Photos.`,
          );
        } else {
          toast.warning("No photos were imported.");
        }
      };

      timer = setInterval(() => {
        void (async () => {
          const closed = !!popup && popup.closed;
          const timedOut = Date.now() - startedAt > 4 * 60_000;
          let ready = false;
          try {
            const pr = await edgeFetch(
              `/api/flipdesk/google/photos/poll?session=${sessionId}`,
            );
            ready = !!((await pr.json()) as { ready?: boolean }).ready;
          } catch {
            /* transient — keep polling */
          }
          if (ready) {
            stop();
            popup?.close();
            try {
              await doImport();
            } catch (err) {
              toast.error(
                `Google Photos import failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            return;
          }
          if (closed || timedOut) {
            stop();
            if (closed) toast.info("Google Photos import cancelled.");
          }
        })();
      }, 2500);
    } catch (err) {
      toast.error(
        `Could not start Google Photos: ${err instanceof Error ? err.message : String(err)}`,
      );
      stop();
    }
  }

  // Sort staged photos by original filename (natural order, so IMG_2 comes
  // before IMG_10). Retried/re-added photos land at the end of the grid;
  // this puts them back in shooting order so capture-sequence grouping is
  // easy again. Photos with no known filename keep their relative order at
  // the end.
  function sortStagedByName() {
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    setStaged((prev) =>
      [...prev].sort((a, b) => {
        const an = stagedSortName(a);
        const bn = stagedSortName(b);
        if (an == null && bn == null) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        return collator.compare(an, bn);
      }),
    );
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Delete staged photos (e.g. accidental duplicates). Drops them from the
  // grid + any group (re-covering or dissolving as needed), clears selection,
  // and best-effort removes the storage objects (current + pre-edit original).
  // The dedup sets rebuild from `staged`, so a deleted photo's source file
  // becomes re-addable automatically.
  function removePhotos(ids: string[]) {
    const idSet = new Set(ids);
    const orphans: string[] = [];
    for (const p of staged) {
      if (!idSet.has(p.id)) continue;
      for (const path of [
        p.storagePath,
        p.thumbnailStoragePath,
        p.original?.storagePath,
        p.original?.thumbnailStoragePath,
      ]) {
        if (path) orphans.push(path);
      }
    }
    setStaged((prev) => prev.filter((p) => !idSet.has(p.id)));
    setGroups((prev) =>
      prev
        .map((g) => {
          const photoIds = g.photoIds.filter((pid) => !idSet.has(pid));
          if (photoIds.length === g.photoIds.length) return g;
          return {
            ...g,
            photoIds,
            coverId: idSet.has(g.coverId) ? (photoIds[0] ?? g.coverId) : g.coverId,
            roles: g.roles
              ? Object.fromEntries(
                  Object.entries(g.roles).filter(([pid]) => !idSet.has(pid)),
                )
              : undefined,
          };
        })
        .filter((g) => g.photoIds.length > 0),
    );
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (orphans.length > 0) {
      void supabase.storage.from("item-photos").remove(orphans);
    }
    toast.success(`Deleted ${ids.length} photo${ids.length === 1 ? "" : "s"}.`);
  }

  // Upload a processed image under a fresh storage key and swap it into the
  // staged photo, snapshotting the previous image into `original` for one-tap
  // revert. Keeps the staged id + capture time so grouping/order survive.
  async function restageProcessed(
    photoId: string,
    processed: {
      full: Blob;
      thumb: Blob;
      width: number;
      height: number;
      contentType: string;
      ext: string;
    },
  ): Promise<boolean> {
    if (!ownerId) return false;
    const existing = stagedById.get(photoId);
    if (!existing) return false;

    // US-529: re-staged (enhanced/bg-removed) images go through the same
    // validated server upload as fresh ones.
    let up: StagedUploadResult;
    try {
      up = await uploadStagingPhoto(
        sessionId.current,
        processed.full,
        processed.thumb,
      );
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[autolister] restage upload failed:", err);
      return false;
    }

    const original = existing.original ?? {
      url: existing.url,
      storagePath: existing.storagePath,
      thumbnailUrl: existing.thumbnailUrl,
      thumbnailStoragePath: existing.thumbnailStoragePath,
      width: existing.width,
      height: existing.height,
      bytes: existing.bytes,
      phash: existing.phash,
    };
    const orphans = existing.original
      ? [existing.storagePath, existing.thumbnailStoragePath].filter(
          (p): p is string => !!p,
        )
      : [];
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: up.url,
              storagePath: up.storagePath,
              thumbnailUrl: up.thumbnailUrl,
              thumbnailStoragePath: up.thumbnailStoragePath,
              width: processed.width,
              height: processed.height,
              bytes: up.bytes,
              phash: "",
              original,
            }
          : p,
      ),
    );
    if (orphans.length > 0) {
      void supabase.storage.from("item-photos").remove(orphans);
    }
    return true;
  }

  // US-535: run on-device segmentation on one staged photo and swap in the
  // cleaned result (studio-white or transparent). Keeps the staged id + capture
  // time so grouping/order survive, snapshots the previous image into `original`
  // for one-tap undo, writes a fresh storage key, and drops the replaced object.
  // The cleaned image flows into BOTH the AI input and the published listing.
  async function applyBgToPhoto(photoId: string, mode: BgMode): Promise<boolean> {
    if (!ownerId) return false;
    const existing = stagedById.get(photoId);
    if (!existing) return false;

    setBgProcessing((prev) => new Set(prev).add(photoId));
    try {
      const srcBlob = await (await fetch(existing.url)).blob();
      const processed = await removeImageBackground(srcBlob, mode, (f) =>
        setModelProgress(f < 1 ? f : null),
      );
      setModelProgress(null);
      const ok = await restageProcessed(photoId, processed);
      if (!ok) {
        toast.error("Could not save cleaned photo.");
        return false;
      }
      return true;
    } catch (err) {
      setModelProgress(null);
      toast.error(
        `Background removal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      setBgProcessing((prev) => {
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
    }
  }

  // US-536: auto-enhance one photo. A `reference` (a group's cover stats) gives
  // every photo of an item the same white-point/exposure.
  async function enhancePhoto(
    photoId: string,
    reference?: EnhanceStats,
  ): Promise<EnhanceStats | null> {
    const existing = stagedById.get(photoId);
    if (!existing) return null;
    setEnhancing((prev) => new Set(prev).add(photoId));
    try {
      const srcBlob = await (await fetch(existing.url)).blob();
      const { image, stats } = await autoEnhance(srcBlob, reference);
      const ok = await restageProcessed(photoId, image);
      if (!ok) {
        toast.error("Could not save enhanced photo.");
        return null;
      }
      return stats;
    } catch (err) {
      toast.error(
        `Auto-enhance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      setEnhancing((prev) => {
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
    }
  }

  // US-535: restore the pre-cleanup original and drop the cleaned objects.
  function undoBg(photoId: string) {
    const existing = stagedById.get(photoId);
    if (!existing?.original) return;
    const o = existing.original;
    const orphans = [existing.storagePath, existing.thumbnailStoragePath].filter(
      (p): p is string => !!p,
    );
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: o.url,
              storagePath: o.storagePath,
              thumbnailUrl: o.thumbnailUrl,
              thumbnailStoragePath: o.thumbnailStoragePath,
              width: o.width,
              height: o.height,
              bytes: o.bytes,
              phash: o.phash,
              original: undefined,
            }
          : p,
      ),
    );
    if (orphans.length > 0) {
      void supabase.storage.from("item-photos").remove(orphans);
    }
  }

  // US-534: persist an edited photo (crop/rotate/straighten) by re-running the
  // SAME stage pipeline as upload — compress → thumbnail → dHash → upload — so
  // the edit feeds BOTH the AI input and the published image. Keeps the staged
  // id + capture time so grouping/order/roles survive; writes a fresh storage
  // key (avoids CDN-caching a reused URL) and cleans up the replaced objects.
  async function replacePhotoWithBlob(photoId: string, blob: Blob): Promise<void> {
    if (!ownerId) return;
    const existing = stagedById.get(photoId);
    if (!existing) return;
    const file = new File([blob], "edited.jpg", { type: blob.type || "image/jpeg" });

    let body: Blob = file;
    let width: number | null = null;
    let height: number | null = null;
    let phash = "";
    let thumbBlob: Blob | null = null;
    try {
      // US-539: same off-thread worker pipeline as fresh uploads.
      const out = await processStagedImage(file, {
        maxWidth: 2400,
        quality: 0.85,
        thumbWidth: 320,
        thumbQuality: 0.7,
      });
      body = out.blob;
      width = out.width;
      height = out.height;
      phash = out.phash;
      thumbBlob = out.thumbBlob;
    } catch (compErr) {
      if (import.meta.env.DEV) console.warn("[autolister] edit compress failed, using edited blob:", compErr);
    }

    // US-529: edits re-land through the validated server upload too — even the
    // compress-failure fallback gets its metadata stripped server-side.
    let up: StagedUploadResult;
    try {
      up = await uploadStagingPhoto(sessionId.current, body, thumbBlob);
    } catch (err) {
      toast.error(
        `Could not save edit: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    const orphans = [existing.storagePath, existing.thumbnailStoragePath].filter(
      (p): p is string => !!p,
    );
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: up.url,
              storagePath: up.storagePath,
              thumbnailUrl: up.thumbnailUrl,
              thumbnailStoragePath: up.thumbnailStoragePath,
              width: width ?? up.width,
              height: height ?? up.height,
              bytes: up.bytes,
              phash,
            }
          : p,
      ),
    );

    // Best-effort: drop the replaced objects so staging doesn't accumulate them.
    if (orphans.length > 0) {
      void supabase.storage.from("item-photos").remove(orphans);
    }
    toast.success("Photo updated.");
  }

  // US-535: one tap to clean every not-yet-cleaned staged photo. Sequential —
  // segmentation is heavy and parallel runs would thrash memory on mobile.
  async function applyBgToAll(mode: BgMode) {
    if (bgBusy) return;
    const targets = staged.filter((p) => !p.original);
    if (targets.length === 0) {
      toast.info("Every photo already has a clean background.");
      return;
    }
    setBgBusy(true);
    try {
      let ok = 0;
      for (const p of targets) {
        if (await applyBgToPhoto(p.id, mode)) ok++;
      }
      if (ok > 0) {
        toast.success(
          `Cleaned ${ok} photo${ok === 1 ? "" : "s"} onto ${mode === "white" ? "studio white" : "a transparent background"}.`,
        );
      }
    } finally {
      setBgBusy(false);
    }
  }

  // US-536: one tap to enhance the whole batch. For each GROUP the cover is
  // enhanced first and its stats are reused for the rest.
  async function enhanceAll() {
    if (enhanceBusy) return;
    if (staged.every((p) => !!p.original)) {
      toast.info("Every photo is already enhanced.");
      return;
    }
    setEnhanceBusy(true);
    try {
      let ok = 0;
      for (const g of groups) {
        const members = g.photoIds
          .map((id) => stagedById.get(id))
          .filter((p): p is StagedPhoto => !!p && !p.original);
        if (members.length === 0) continue;
        const coverId =
          members.find((m) => m.id === g.coverId)?.id ?? members[0]!.id;
        const stats = await enhancePhoto(coverId);
        if (stats) ok++;
        for (const m of members) {
          if (m.id === coverId) continue;
          if (await enhancePhoto(m.id, stats ?? undefined)) ok++;
        }
      }
      for (const p of ungrouped) {
        if (p.original) continue;
        if (await enhancePhoto(p.id)) ok++;
      }
      if (ok > 0) {
        toast.success(`Auto-enhanced ${ok} photo${ok === 1 ? "" : "s"}.`);
      }
    } finally {
      setEnhanceBusy(false);
    }
  }

  function createGroupFromSelection() {
    const ids = Array.from(selected).filter((id) => !groupedIds.has(id));
    if (ids.length === 0) return;
    setGroups((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: `Item ${prev.length + 1}`,
        photoIds: ids,
        coverId: ids[0]!,
      },
    ]);
    setSelected(new Set());
  }

  // US-532: auto-group the ungrouped photos into per-item listings by EXIF
  // capture-time bursts + a dHash visual second pass. Existing manual groups are
  // preserved; detected groups are appended so the user can then merge/split.
  function autoGroup() {
    const input: GroupablePhoto[] = ungrouped.map((p) => ({
      id: p.id,
      capturedAt: p.capturedAtMs != null ? new Date(p.capturedAtMs) : null,
      phash: p.phash,
    }));
    if (input.length === 0) return;
    const auto = autoGroupPhotos(input);
    setGroups((prev) => [
      ...prev,
      ...auto.map((g, i) => ({
        id: crypto.randomUUID(),
        name: `Item ${prev.length + i + 1}`,
        photoIds: g.photoIds,
        coverId: g.coverId,
      })),
    ]);
    setSelected(new Set());
    toast.success(
      `Auto-grouped ${input.length} photo${input.length === 1 ? "" : "s"} into ${auto.length} item${auto.length === 1 ? "" : "s"}. Tweak as needed.`,
    );
  }

  function updateGroup(id: string, patch: Partial<Group>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  // US-533: the cover is always the front shot. Promote the chosen photo to
  // cover+front and demote the previous cover (if it was a front) to detail, so
  // we never carry two "front" tags.
  function setCover(groupId: string, photoId: string) {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const roles: Record<string, PhotoRole> = { ...(g.roles ?? {}) };
        if (g.coverId && g.coverId !== photoId && roles[g.coverId] === "front") {
          roles[g.coverId] = "detail";
        }
        roles[photoId] = "front";
        return { ...g, coverId: photoId, roles };
      }),
    );
  }

  // US-533: override a non-cover photo's role. (The cover's role is fixed to
  // "front" — change the front by picking a new cover.)
  function setPhotoRole(groupId: string, photoId: string, role: PhotoRole) {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? { ...g, roles: { ...(g.roles ?? {}), [photoId]: role } }
          : g,
      ),
    );
  }

  // US-533: run the AI cover/role vision pass for one group and apply the
  // result. Returns true on success. edgeFetch surfaces the 402 upgrade dialog
  // for locked plans, so we don't handle gating here.
  async function autoTagGroup(groupId: string): Promise<boolean> {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return false;
    const photos = g.photoIds
      .map((pid) => stagedById.get(pid))
      .filter((p): p is StagedPhoto => !!p);
    if (photos.length === 0) return false;

    setTaggingGroups((prev) => new Set(prev).add(groupId));
    try {
      const res = await edgeFetch("/api/flipdesk/autolister/classify-photos", {
        method: "POST",
        json: {
          photos: photos.map((p) => ({ id: p.id, storage_path: p.storagePath })),
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        cover_id?: string;
        roles?: Record<string, PhotoRole>;
        error?: string;
      };
      if (!res.ok) {
        toast.error(json.error || "Could not auto-tag photos.");
        return false;
      }
      const cover =
        typeof json.cover_id === "string" && g.photoIds.includes(json.cover_id)
          ? json.cover_id
          : g.coverId;
      updateGroup(groupId, { coverId: cover, roles: json.roles ?? {} });
      return true;
    } catch (err) {
      toast.error(
        `Auto-tag failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      setTaggingGroups((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  }

  // US-533: classify every group. Sequential — each is a vision call and the
  // endpoint is rate-limited (20/min) — so we don't burst.
  async function autoTagAllGroups() {
    if (groups.length === 0 || taggingAll) return;
    setTaggingAll(true);
    try {
      let ok = 0;
      for (const g of groups) {
        if (await autoTagGroup(g.id)) ok++;
      }
      if (ok > 0) {
        toast.success(`Auto-tagged ${ok} listing${ok === 1 ? "" : "s"}.`);
      }
    } finally {
      setTaggingAll(false);
    }
  }

  function removePhotoFromGroup(groupId: string, photoId: string) {
    setGroups((prev) =>
      prev
        .map((g) => {
          if (g.id !== groupId) return g;
          const photoIds = g.photoIds.filter((p) => p !== photoId);
          return {
            ...g,
            photoIds,
            coverId: g.coverId === photoId ? (photoIds[0] ?? "") : g.coverId,
          };
        })
        .filter((g) => g.photoIds.length > 0),
    );
  }

  function deleteGroup(groupId: string) {
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  }

  // US-317: merge two or more groups. Keeps the first group's name and cover,
  // concatenates the rest's photos. Called when 2+ groups are checkbox-selected
  // via the group toolbar's "Merge selected" action.
  function mergeGroups(groupIds: string[]) {
    if (groupIds.length < 2) return;
    setGroups((prev) => {
      const survivors = prev.filter((g) => !groupIds.includes(g.id));
      const merged = prev.filter((g) => groupIds.includes(g.id));
      if (merged.length < 2) return prev;
      const allIds = Array.from(new Set(merged.flatMap((g) => g.photoIds)));
      const head = merged[0]!;
      const combined: Group = {
        id: head.id,
        name: head.name,
        photoIds: allIds,
        coverId: allIds.includes(head.coverId) ? head.coverId : (allIds[0] ?? ""),
      };
      // Preserve the relative order of the first merged group.
      const headIdx = prev.findIndex((g) => g.id === head.id);
      const out = [...survivors];
      out.splice(Math.min(headIdx, out.length), 0, combined);
      return out;
    });
  }

  // US-317: clear the persisted session AFTER a successful generate so we
  // don't re-show drafts on the next visit.
  function clearStoredSession() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem("autolister:sessionId");
    } catch {
      /* best-effort */
    }
  }

  async function generate() {
    if (!ownerId) return;
    if (groups.length === 0) {
      toast.error("Create at least one group first.");
      return;
    }
    setBusy(true);
    try {
      const itemIds: string[] = [];
      for (const g of groups) {
        const photos = g.photoIds
          .map((pid) => stagedById.get(pid))
          .filter((p): p is StagedPhoto => !!p);
        if (photos.length === 0) continue;

        // US-533: cover first (front), then the rest ordered by role
        // (back → tag → detail → defect). photo_type carries the assigned role
        // so the eBay gallery is well-ordered and labeled, not all "detail".
        const roleOf = (p: StagedPhoto): PhotoRole =>
          p.id === g.coverId ? "front" : (g.roles?.[p.id] ?? "detail");
        const ordered = [...photos].sort((a, b) => {
          if (a.id === g.coverId) return -1;
          if (b.id === g.coverId) return 1;
          return ROLE_ORDER[roleOf(a)] - ROLE_ORDER[roleOf(b)];
        });

        // SKU binding: if the seller gave a SKU that already exists in their
        // inventory, attach the photos to THAT item (the SKU is unique per user,
        // so a new insert would fail anyway) and keep its sheet-imported fields
        // for field-by-field reconciliation against the AI draft. Otherwise
        // create a fresh item, stamping the SKU when provided.
        const sku = g.sku?.trim() || "";
        let itemId: string;
        let existingId: string | null = null;
        if (sku) {
          const { data: existing } = await supabase
            .from("inventory_items")
            .select("id")
            .eq("user_id", ownerId)
            .eq("sku", sku)
            .maybeSingle();
          existingId = (existing as { id: string } | null)?.id ?? null;
        }
        if (existingId) {
          itemId = existingId;
          await supabase
            .from("inventory_items")
            .update({ status: "photographed" } as never)
            .eq("id", itemId);
        } else {
          const { data: item, error: itemErr } = await supabase
            .from("inventory_items")
            .insert({
              user_id: ownerId,
              title: g.name.trim() || "AutoLister item",
              sku: sku || null,
              status: "photographed",
            } as never)
            .select("id")
            .single();
          if (itemErr || !item) throw itemErr ?? new Error("Item create failed");
          itemId = (item as { id: string }).id;
        }

        const photoRows = ordered.map((p, idx) => ({
          inventory_item_id: itemId,
          photo_url: p.url,
          storage_path: p.storagePath,
          thumbnail_url: p.thumbnailUrl,
          thumbnail_storage_path: p.thumbnailStoragePath,
          photo_type: roleOf(p),
          sort_order: idx,
          width: p.width,
          height: p.height,
          bytes: p.bytes,
        }));
        const { error: photoErr } = await supabase
          .from("item_photos")
          .insert(photoRows as never);
        if (photoErr) throw photoErr;

        itemIds.push(itemId);
      }

      if (itemIds.length === 0) {
        toast.error("Add photos to at least one group.");
        return;
      }

      // Invalidate the shared items_full cache (composer/inventory/grid/
      // analytics all share `["items_full", user?.id]` with a 5min staleTime).
      // Without this, the composer's "Review" link can open before TanStack
      // Query refetches, fail to find the newly-created item, and render
      // "Item not found." Same applies to any inventory surface the user
      // visits next.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      const res = await startBatch.mutateAsync({
        item_ids: itemIds,
        auto_publish_green: autoPublishGreen,
      });
      // Clear the persisted session — the batch is now durable on the server,
      // and re-showing the staged photos on the next visit would be confusing.
      clearStoredSession();
      navigate(`/dashboard/flipdesk/autolister/queue?batch=${res.batch_id}`);
    } catch (err) {
      toast.error(
        `Could not start generation: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Sparkles className="h-6 w-6 text-brand-red-text" />
            AutoLister
          </h1>
          <p className="text-sm text-muted-foreground">
            Upload a batch of photos, group them into items, and generate
            complete eBay listings in seconds.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button
            onClick={generate}
            disabled={busy || groups.length === 0 || uploading > 0 || !entitled}
            size="lg"
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Generate {groups.length > 0 ? `${groups.length} listing${groups.length === 1 ? "" : "s"}` : ""}
          </Button>
          {/* US-955: fire-and-forget auto-publish of the green, clean drafts. */}
          {entitled && (
            <label
              className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
              title="When generation finishes, automatically publish only the high-confidence (green) drafts that pass the eBay pre-flight. Drafts that need review, are blocked, or are scheduled stay as drafts."
            >
              <input
                type="checkbox"
                checked={autoPublishGreen}
                onChange={(e) => setAutoPublishGreen(e.target.checked)}
                disabled={busy}
                className="h-3.5 w-3.5 rounded border-input accent-primary"
              />
              Auto-publish green drafts when done
            </label>
          )}
        </div>
      </div>

      {/* US-957: pre-generation cover-QA advisory. Non-blocking — it never
          disables Generate, it just nudges a reshoot to save AI quota. */}
      {entitled && lowCoverCount > 0 && (
        <Card className="flex items-start gap-2 border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <Camera className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-amber-800 dark:text-amber-200">
            <span className="font-medium">
              {lowCoverCount} item{lowCoverCount === 1 ? "" : "s"} could use a
              better cover photo.
            </span>{" "}
            Reshoot the flagged covers below for sharper listings — or generate
            anyway, this is only a suggestion.
          </p>
        </Card>
      )}

      {/* Premium gate (US-323) — shown when the plan doesn't include AutoLister.
          The server also enforces this; this is the in-app upsell. */}
      {!entitled && !billingLoading && (
        <Card className="border-brand-red/40 bg-brand-red/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 text-brand-red-text" />
                AutoLister is a Pro feature
              </h2>
              <p className="text-sm text-muted-foreground">
                Upgrade to Pro or Business to turn batches of photos into
                complete eBay listings automatically.
              </p>
            </div>
            <Button
              onClick={() =>
                useUpgradeDialogStore.getState().show({
                  reason: { type: "feature", feature: "autolister" },
                  currentPlan: plan,
                  requiredPlan: "pro",
                })
              }
            >
              Upgrade to unlock
            </Button>
          </div>
        </Card>
      )}

      {/* Upload (US-530: drag-and-drop + folder + paste) */}
      <Card
        className={cn("p-4 transition-shadow", dragging && "ring-2 ring-primary")}
        onDragOver={(e) => {
          if (!entitled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!entitled) return;
          void filesFromDataTransfer(e.dataTransfer).then((fs) => handleFiles(fs));
        }}
        onPaste={(e) => {
          if (!entitled) return;
          const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) =>
            f.type.startsWith("image/") || isVideoFile(f),
          );
          if (imgs.length > 0) void handleFiles(imgs);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif,video/*,.mov,.mp4,.m4v"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          // webkitdirectory/directory are non-standard but widely supported and
          // not in React's typed attrs — spread them past the type checker.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!entitled}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-10 text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:text-muted-foreground"
        >
          {uploading > 0 ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : (
            <Upload className="h-7 w-7" />
          )}
          <span className="text-sm font-medium">
            {uploading > 0
              ? `Uploading ${uploading}…`
              : "Drag photos or a folder here, or click to choose"}
          </span>
          <span className="text-xs">
            iPhone HEIC and Live Photos supported. Resized &amp; compressed in your browser before upload.
          </span>
        </button>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => folderInputRef.current?.click()}
            disabled={!entitled}
          >
            <FolderOpen className="mr-1.5 h-4 w-4" />
            Pick a folder
          </Button>
          {gpConfigured && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void importFromGooglePhotos()}
              disabled={!entitled || gpImporting}
            >
              {gpImporting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Images className="mr-1.5 h-4 w-4" />
              )}
              Import from Google Photos
            </Button>
          )}
        </div>
      </Card>

      {/* US-539: per-file progress bars + per-file failure retry */}
      {uploadTasks.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {uploading > 0
                ? `Uploading ${uploadTasks.filter((t) => t.status === "done" || t.status === "error").length} of ${uploadTasks.length}…`
                : `${uploadTasks.filter((t) => t.status === "error").length} photo${uploadTasks.filter((t) => t.status === "error").length === 1 ? "" : "s"} failed`}
            </span>
            {uploading === 0 && (
              <div className="flex items-center gap-2">
                {uploadTasks.some((t) => t.status === "error" && t.retryable !== false) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void retryUploadTasks(
                        uploadTasks
                          .filter((t) => t.status === "error" && t.retryable !== false)
                          .map((t) => t.id),
                      )
                    }
                  >
                    <RotateCcw className="mr-1 h-4 w-4" />
                    Retry failed
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setUploadTasks([])}>
                  Dismiss all
                </Button>
              </div>
            )}
          </div>
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {uploadTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-xs">
                <span className="w-36 shrink-0 truncate sm:w-48" title={t.name}>
                  {t.name}
                </span>
                {t.status === "error" ? (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate text-destructive"
                      title={t.error}
                    >
                      {t.error}
                    </span>
                    {t.retryable !== false && (
                      <button
                        type="button"
                        title="Retry this photo"
                        onClick={() => void retryUploadTasks([t.id])}
                        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-muted"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      title="Dismiss"
                      onClick={() => dismissUploadTask(t.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <>
                    <Progress value={t.progress} className="h-1.5 min-w-0 flex-1" />
                    <span className="w-20 shrink-0 text-right text-muted-foreground">
                      {t.status === "queued" && "Queued"}
                      {t.status === "processing" && "Processing…"}
                      {t.status === "uploading" && "Uploading…"}
                      {t.status === "done" && "Done"}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* US-536: one-tap auto-enhance across the whole batch */}
      {staged.length > 0 && entitled && (
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-2">
            <WandSparkles className="h-4 w-4 text-brand-red-text" />
            <span className="text-sm font-medium">Auto-enhance</span>
          </div>
          <Button
            size="sm"
            onClick={enhanceAll}
            disabled={enhanceBusy || staged.every((p) => !!p.original)}
          >
            {enhanceBusy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <WandSparkles className="mr-1 h-4 w-4" />
            )}
            Enhance all ({staged.filter((p) => !p.original).length})
          </Button>
          <span className="text-xs text-muted-foreground">
            Auto-crops to the item, white-balances &amp; evens out exposure.
          </span>
        </Card>
      )}

      {/* US-535: one-tap on-device studio background across the whole batch */}
      {staged.length > 0 && entitled && (
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-2">
            <Eraser className="h-4 w-4 text-brand-red-text" />
            <span className="text-sm font-medium">Studio background</span>
          </div>
          <div className="inline-flex overflow-hidden rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setBgMode("white")}
              className={cn(
                "px-2.5 py-1",
                bgMode === "white"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              Studio white
            </button>
            <button
              type="button"
              onClick={() => setBgMode("transparent")}
              className={cn(
                "border-l px-2.5 py-1",
                bgMode === "transparent"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              Transparent
            </button>
          </div>
          <Button
            size="sm"
            onClick={() => applyBgToAll(bgMode)}
            disabled={bgBusy || staged.every((p) => !!p.original)}
          >
            {bgBusy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Eraser className="mr-1 h-4 w-4" />
            )}
            Clean all ({staged.filter((p) => !p.original).length})
          </Button>
          <span className="text-xs text-muted-foreground">
            {modelProgress != null
              ? `Downloading model… ${Math.round(modelProgress * 100)}%`
              : "Runs in your browser · no per-photo cost · first use downloads a model"}
          </span>
        </Card>
      )}

      {/* Ungrouped staging area */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Ungrouped photos {ungrouped.length > 0 && `(${ungrouped.length})`}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={sortStagedByName}
              disabled={ungrouped.length < 2}
              title="Sort photos by filename (natural order) so they line up in shooting order"
            >
              <ArrowDownAZ className="mr-1 h-4 w-4" />
              Sort by name
            </Button>
            <Button
              size="sm"
              onClick={autoGroup}
              disabled={ungrouped.length === 0}
              title="Group photos into items automatically by capture time + visual similarity"
            >
              <Wand2 className="mr-1 h-4 w-4" />
              Auto-group ({ungrouped.length})
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={createGroupFromSelection}
              disabled={selected.size === 0}
            >
              <Plus className="mr-1 h-4 w-4" />
              New group from selected ({selected.size})
            </Button>
            {selected.size > 0 && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => removePhotos(Array.from(selected))}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Delete selected ({selected.size})
              </Button>
            )}
          </div>
        </div>
        {ungrouped.length === 0 ? (
          <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
            {staged.length === 0
              ? "No photos yet — upload some above."
              : "All photos are grouped. Generate when ready."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {ungrouped.map((p) => {
              const bgInFlight = bgProcessing.has(p.id);
              const enhancingInFlight = enhancing.has(p.id);
              const processing = bgInFlight || enhancingInFlight;
              const cleaned = !!p.original;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "group relative aspect-square overflow-hidden rounded-md border-2",
                    selected.has(p.id)
                      ? "border-primary ring-2 ring-primary/40"
                      : "border-transparent hover:border-muted-foreground/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSelect(p.id)}
                    aria-label="Select photo"
                    className="absolute inset-0"
                  >
                    <StagedThumb
                      src={itemPhotoThumb({
                        thumbnail_url: p.thumbnailUrl,
                        photo_url: p.url,
                      })}
                      className="h-full w-full object-cover"
                    />
                  </button>
                  {selected.has(p.id) && (
                    <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                      ✓
                    </span>
                  )}
                  <button
                    type="button"
                    title="Delete photo"
                    aria-label="Delete photo"
                    onClick={() => removePhotos([p.id])}
                    disabled={processing}
                    className="absolute left-1 top-1 z-10 rounded-full bg-black/55 p-1 text-white opacity-0 hover:bg-red-600 group-hover:opacity-100 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {/* US-535: per-photo clean / undo */}
                  {cleaned ? (
                    <button
                      type="button"
                      title="Undo background removal"
                      onClick={() => undoBg(p.id)}
                      className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white opacity-0 group-hover:opacity-100"
                    >
                      <Undo2 className="h-3 w-3" />
                      Undo
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        title="Clean background"
                        onClick={() => applyBgToPhoto(p.id, bgMode)}
                        disabled={processing || bgBusy}
                        className="absolute bottom-1 left-1 z-10 rounded-full bg-black/55 p-1 text-white opacity-0 group-hover:opacity-100"
                      >
                        <Eraser className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title="Auto-enhance"
                        onClick={() => void enhancePhoto(p.id)}
                        disabled={processing || enhanceBusy}
                        className="absolute bottom-1 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 p-1 text-white opacity-0 group-hover:opacity-100"
                      >
                        <WandSparkles className="h-3 w-3" />
                      </button>
                    </>
                  )}
                  {/* US-534: crop/rotate/straighten */}
                  <button
                    type="button"
                    title="Edit photo"
                    onClick={() => setEditingPhotoId(p.id)}
                    disabled={processing}
                    className="absolute bottom-1 right-1 z-10 rounded-full bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100 disabled:opacity-30"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {processing && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Groups */}
      {groups.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Listings to generate ({groups.length})
            </h2>
            <div className="flex items-center gap-2">
              {selectedGroups.size >= 2 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    mergeGroups(Array.from(selectedGroups));
                    setSelectedGroups(new Set());
                  }}
                >
                  <Combine className="mr-1 h-4 w-4" />
                  Merge {selectedGroups.size} groups
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={autoTagAllGroups}
                disabled={taggingAll || taggingGroups.size > 0}
                title="Pick the best cover and tag each photo's role with AI"
              >
                {taggingAll ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Tags className="mr-1 h-4 w-4" />
                )}
                Auto-tag all
              </Button>
            </div>
          </div>
          {groups.map((g) => (
            <Card key={g.id} className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedGroups.has(g.id)}
                  onChange={(e) =>
                    setSelectedGroups((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(g.id);
                      else next.delete(g.id);
                      return next;
                    })
                  }
                  aria-label={`Select group ${g.name}`}
                  className="h-4 w-4"
                />
                <Input
                  value={g.name}
                  onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                  className="h-8 max-w-xs"
                  placeholder="Item name"
                />
                <Input
                  value={g.sku ?? ""}
                  onChange={(e) => updateGroup(g.id, { sku: e.target.value })}
                  className="h-8 w-28"
                  placeholder="SKU / #"
                  title="Your inventory SKU. If it matches an existing item, the AI draft is reconciled against it."
                />
                <Badge variant="secondary">{g.photoIds.length} photos</Badge>
                {/* US-957: non-blocking reshoot nudge when the cover scores low.
                    Advisory only — Generate is never gated on this. */}
                {(() => {
                  const score = coverScores[g.coverId];
                  if (score == null || score < 0 || score >= COVER_QA_REVIEW_THRESHOLD) {
                    return null;
                  }
                  return (
                    <Badge
                      variant="outline"
                      className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                      title={`The cover photo scored ${score}/100 for listing-readiness. A sharper, well-lit cover sells faster — reshoot it before generating if you can. (Optional — you can still generate.)`}
                    >
                      <Camera className="h-3 w-3" />
                      Reshoot recommended
                    </Badge>
                  );
                })()}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => autoTagGroup(g.id)}
                    disabled={taggingGroups.has(g.id) || taggingAll}
                    title="Pick the best cover and tag each photo's role with AI"
                  >
                    {taggingGroups.has(g.id) ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Tags className="mr-1 h-4 w-4" />
                    )}
                    Auto-tag
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => deleteGroup(g.id)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {g.photoIds.map((pid) => {
                  const p = stagedById.get(pid);
                  if (!p) return null;
                  const isCover = g.coverId === pid;
                  return (
                    <div
                      key={pid}
                      className={cn(
                        "group relative aspect-square overflow-hidden rounded-md border-2",
                        isCover ? "border-brand-red" : "border-transparent",
                      )}
                    >
                      <StagedThumb
                        src={itemPhotoThumb({
                          thumbnail_url: p.thumbnailUrl,
                          photo_url: p.url,
                        })}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        title="Set as cover"
                        onClick={() => setCover(g.id, pid)}
                        className={cn(
                          "absolute left-1 top-1 rounded-full p-0.5",
                          isCover
                            ? "bg-brand-red text-white"
                            : "bg-black/40 text-white opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <Star className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title="Remove from group"
                        onClick={() => removePhotoFromGroup(g.id, pid)}
                        className="absolute right-1 top-1 rounded-full bg-black/40 p-0.5 text-white opacity-0 group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      {/* US-534: crop/rotate/straighten */}
                      <button
                        type="button"
                        title="Edit photo"
                        onClick={() => setEditingPhotoId(pid)}
                        className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white opacity-0 group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {/* US-533: cover is the front; others show an editable role. */}
                      {isCover ? (
                        <span className="absolute inset-x-0 bottom-0 bg-brand-red/90 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-white">
                          Front
                        </span>
                      ) : (
                        <select
                          value={g.roles?.[pid] ?? "detail"}
                          onChange={(e) =>
                            setPhotoRole(g.id, pid, e.target.value as PhotoRole)
                          }
                          aria-label="Photo role"
                          className="absolute inset-x-0 bottom-0 w-full cursor-pointer border-0 bg-black/60 py-0.5 text-center text-[10px] text-white outline-none"
                        >
                          <option value="back">Back</option>
                          <option value="tag">Tag</option>
                          <option value="detail">Detail</option>
                          <option value="defect">Defect</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}

      {staged.length === 0 && groups.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
          Your grouped listings will appear here.
        </div>
      )}

      {/* US-534: crop/rotate/straighten one staged photo. Edits re-enter the
          stage pipeline so both the AI input and the published image use them. */}
      {editingPhotoId &&
        (() => {
          const editing = stagedById.get(editingPhotoId);
          if (!editing) return null;
          return (
            <PhotoEditorDialog
              open
              src={editing.url}
              onClose={() => setEditingPhotoId(null)}
              onSave={async (blob) => {
                try {
                  await replacePhotoWithBlob(editingPhotoId, blob);
                  setEditingPhotoId(null);
                } catch {
                  /* toast already shown; keep the dialog open to retry/cancel */
                }
              }}
            />
          );
        })()}
    </div>
  );
}
