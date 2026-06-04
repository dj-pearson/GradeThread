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
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { compressImage } from "@/lib/image-utils";
import { readCaptureTime } from "@/lib/exif";
import { autoGroupPhotos, type GroupablePhoto } from "@/lib/autolister-grouping";
import { autoEnhance, type EnhanceStats } from "@/lib/image-enhance";
import { useStartAutolisterBatch } from "@/hooks/use-autolister";
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
  // US-536: snapshot of the pre-enhance image so a one-tap auto-enhance can be
  // reverted. Present only after enhancing; cleared on revert.
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

function looksHeic(file: File): boolean {
  const lc = file.name.toLowerCase();
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    lc.endsWith(".heic") ||
    lc.endsWith(".heif")
  );
}

// US-531: transcode iPhone HEIC/HEIF to JPEG in the browser so those photos
// "just work" instead of being skipped. heic2any (~1.4MB wasm) is dynamic-
// imported ONLY when a HEIC file is actually present, so it never enters the
// main bundle. Returns the original file unchanged for non-HEIC inputs.
async function maybeTranscodeHeic(file: File): Promise<File> {
  if (!looksHeic(file)) return file;
  const { default: heic2any } = await import("heic2any");
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const blob = Array.isArray(out) ? out[0]! : out;
  const name = file.name.replace(/\.(heic|heif)$/i, ".jpg");
  return new File([blob], name, { type: "image/jpeg" });
}

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
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
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
  // US-536: photos currently being auto-enhanced, and a batch-busy flag.
  const [enhancing, setEnhancing] = useState<Set<string>>(new Set());
  const [enhanceBusy, setEnhanceBusy] = useState(false);

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

  async function handleFiles(files: FileList | File[] | null) {
    if (!files || !ownerId) return;
    const list = Array.from(files);
    setUploading((n) => n + list.length);
    const added: StagedPhoto[] = [];
    let heicFailed = 0;
    for (const file of list) {
      try {
        // US-532: capture EXIF time from the ORIGINAL file (incl. HEIC) before
        // any transcode/recompression that may drop the metadata — it drives
        // capture-time auto-grouping.
        const capturedAt = await readCaptureTime(file).catch(() => null);
        // US-531: iPhone HEIC/HEIF is transcoded to JPEG in the browser so it
        // works instead of being rejected; non-HEIC files pass through.
        let workFile: File;
        try {
          workFile = await maybeTranscodeHeic(file);
        } catch (heicErr) {
          console.warn("[autolister] HEIC transcode failed:", heicErr);
          heicFailed++;
          continue;
        }
        if (!workFile.type.startsWith("image/")) continue;
        const id = crypto.randomUUID();
        let body: Blob = workFile;
        let bodyType = workFile.type || "image/webp";
        let width: number | null = null;
        let height: number | null = null;
        let phash = "";
        let thumbBlob: Blob | null = null;
        let thumbType = "image/webp";
        let compressed = false;
        try {
          const main = await compressImage(workFile, 2400, 0.85);
          body = main.blob;
          bodyType = main.blob.type || "image/webp";
          width = main.width;
          height = main.height;
          phash = main.phash; // US-532: dHash for the visual grouping pass
          const thumb = await compressImage(workFile, 320, 0.7);
          thumbBlob = thumb.blob;
          thumbType = thumb.blob.type || "image/webp";
          compressed = true;
        } catch (compErr) {
          console.warn("[autolister] compress failed, using original:", compErr);
        }
        // If compression failed AND the file is huge (>15MB), the AI generation
        // will likely choke too. Skip with a clear message.
        if (!compressed && workFile.size > 15 * 1024 * 1024) {
          toast.error(
            `"${workFile.name}" is ${(workFile.size / 1024 / 1024).toFixed(1)}MB and couldn't be compressed in the browser. Please convert it to a regular JPEG and try again.`,
          );
          continue;
        }

        const base = `${ownerId}/_staging/${sessionId.current}/${id}`;
        const path = `${base}.${extForBlobType(bodyType)}`;
        const { error: upErr } = await supabase.storage
          .from("item-photos")
          .upload(path, body, { upsert: false, contentType: bodyType });
        if (upErr) throw upErr;
        const url = supabase.storage.from("item-photos").getPublicUrl(path).data
          .publicUrl;

        let thumbnailUrl: string | null = null;
        let thumbnailStoragePath: string | null = null;
        if (thumbBlob) {
          const tpath = `${base}_thumb.${extForBlobType(thumbType)}`;
          const { error: tErr } = await supabase.storage
            .from("item-photos")
            .upload(tpath, thumbBlob, { upsert: false, contentType: thumbType });
          if (!tErr) {
            thumbnailStoragePath = tpath;
            thumbnailUrl = supabase.storage.from("item-photos").getPublicUrl(
              tpath,
            ).data.publicUrl;
          }
        }

        added.push({
          id,
          url,
          storagePath: path,
          thumbnailUrl,
          thumbnailStoragePath,
          width,
          height,
          bytes: body.size,
          capturedAtMs: capturedAt ? capturedAt.getTime() : null,
          phash,
        });
      } catch (err) {
        toast.error(
          `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    if (added.length > 0) {
      setStaged((prev) => [...prev, ...added]);
      toast.success(`${added.length} photo${added.length === 1 ? "" : "s"} added.`);
    }
    if (heicFailed > 0) {
      toast.warning(
        `${heicFailed} HEIC photo${heicFailed === 1 ? "" : "s"} couldn't be converted.`,
        {
          description:
            "Re-export them as JPEG (Photos app → Share → Save as Files → JPEG) and try again.",
          duration: 8_000,
        },
      );
    }
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

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // US-536: upload a processed image under a fresh storage key and swap it into
  // the staged photo, snapshotting the previous image into `original` for one-
  // tap revert. Keeps the staged id + capture time so grouping/order survive;
  // the processed image flows into BOTH the AI input and the published listing.
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

    const editId = crypto.randomUUID();
    const base = `${ownerId}/_staging/${sessionId.current}/${editId}`;
    const path = `${base}.${processed.ext}`;
    const { error: upErr } = await supabase.storage
      .from("item-photos")
      .upload(path, processed.full, {
        upsert: false,
        contentType: processed.contentType,
      });
    if (upErr) {
      toast.error(`Could not save photo: ${upErr.message}`);
      return false;
    }
    const url = supabase.storage.from("item-photos").getPublicUrl(path).data
      .publicUrl;

    let thumbnailUrl: string | null = null;
    let thumbnailStoragePath: string | null = null;
    const tpath = `${base}_thumb.${processed.ext}`;
    const { error: tErr } = await supabase.storage
      .from("item-photos")
      .upload(tpath, processed.thumb, {
        upsert: false,
        contentType: processed.contentType,
      });
    if (!tErr) {
      thumbnailStoragePath = tpath;
      thumbnailUrl = supabase.storage.from("item-photos").getPublicUrl(tpath).data
        .publicUrl;
    }

    // Snapshot the TRUE original once; re-processing only replaces the prior
    // processed objects (which become orphans), never the saved original.
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
              url,
              storagePath: path,
              thumbnailUrl,
              thumbnailStoragePath,
              width: processed.width,
              height: processed.height,
              bytes: processed.full.size,
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

  // US-536: auto-enhance one photo. A `reference` (a group's cover stats) gives
  // every photo of an item the same white-point/exposure. Returns the stats used
  // so the cover's can be threaded through the rest of the group.
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
      return ok ? stats : null;
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

  // US-536: restore the pre-enhance original and drop the processed objects.
  function revertEnhance(photoId: string) {
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

  // US-536: one tap to enhance the whole batch. For each GROUP the cover is
  // enhanced first and its stats are reused for the rest (multi-angle
  // consistency — shared white-point/exposure); ungrouped photos are enhanced
  // independently. Sequential: the pixel work is heavy.
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

        const { data: item, error: itemErr } = await supabase
          .from("inventory_items")
          .insert({
            user_id: ownerId,
            title: g.name.trim() || "AutoLister item",
            status: "photographed",
          } as never)
          .select("id")
          .single();
        if (itemErr || !item) throw itemErr ?? new Error("Item create failed");
        const itemId = (item as { id: string }).id;

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
      const res = await startBatch.mutateAsync({ item_ids: itemIds });
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
            <Sparkles className="h-6 w-6 text-brand-red" />
            AutoLister
          </h1>
          <p className="text-sm text-muted-foreground">
            Upload a batch of photos, group them into items, and generate
            complete eBay listings in seconds.
          </p>
        </div>
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
      </div>

      {/* Premium gate (US-323) — shown when the plan doesn't include AutoLister.
          The server also enforces this; this is the in-app upsell. */}
      {!entitled && !billingLoading && (
        <Card className="border-brand-red/40 bg-brand-red/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 text-brand-red" />
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
            f.type.startsWith("image/"),
          );
          if (imgs.length > 0) void handleFiles(imgs);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif"
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
            iPhone HEIC supported. Resized &amp; compressed in your browser before upload.
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

      {/* US-536: one-tap auto-enhance across the whole batch */}
      {staged.length > 0 && entitled && (
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex items-center gap-2">
            <WandSparkles className="h-4 w-4 text-brand-red" />
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
            Auto-crops to the item, white-balances &amp; evens out exposure ·
            consistent across each item · runs in your browser
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
              const processing = enhancing.has(p.id);
              const enhanced = !!p.original;
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
                    <img
                      src={p.thumbnailUrl ?? p.url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                  {selected.has(p.id) && (
                    <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                      ✓
                    </span>
                  )}
                  {/* US-536: per-photo enhance / revert */}
                  {enhanced ? (
                    <button
                      type="button"
                      title="Revert to original"
                      onClick={() => revertEnhance(p.id)}
                      className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white opacity-0 group-hover:opacity-100"
                    >
                      <Undo2 className="h-3 w-3" />
                      Revert
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Auto-enhance"
                      onClick={() => enhancePhoto(p.id)}
                      disabled={processing || enhanceBusy}
                      className="absolute bottom-1 left-1 z-10 rounded-full bg-black/55 p-1 text-white opacity-0 group-hover:opacity-100"
                    >
                      <WandSparkles className="h-3 w-3" />
                    </button>
                  )}
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
                <Badge variant="secondary">{g.photoIds.length} photos</Badge>
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
                      <img
                        src={p.thumbnailUrl ?? p.url}
                        alt=""
                        loading="lazy"
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
    </div>
  );
}
