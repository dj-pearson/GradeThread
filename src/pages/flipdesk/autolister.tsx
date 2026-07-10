import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Ungroup,
  GripVertical,
  FolderInput,
  ArrowUpDown,
  Layers,
} from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { itemPhotoThumb } from "@/lib/images";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { processStagedImage } from "@/lib/image-worker-pool";
import { isVideoFile } from "@/lib/media-intake";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  movePhotosToGroup,
  reorderWithinGroup,
} from "@/lib/autolister-group-edits";
import {
  autoGroupPhotos,
  compareByProvenance,
  type GroupablePhoto,
  sequenceRuns,
} from "@/lib/autolister-grouping";
import {
  type GroupEditKind,
  groupingCorrectionScore,
  manualGroupsCreated,
  trackAiSuggestion,
  trackAutogroupRun,
  trackGroupEdit,
  trackGroupingOutcome,
} from "@/lib/autolister-telemetry";
import {
  type StagedPhoto,
  type StagedUploadResult,
  uploadStagingPhoto,
  useAutolisterUploadStore,
} from "@/stores/autolister-upload-store";
import { autoEnhance, type EnhanceStats } from "@/lib/image-enhance";
import { removeImageBackground, type BgMode } from "@/lib/background-removal";
import { useStartAutolisterBatch, useRunCoverQa } from "@/hooks/use-autolister";
import {
  dedupeSuggestions,
  MAX_VERIFY_SAMPLE_PHOTOS,
  planVerifyWindows,
} from "@/lib/autolister-verify-windows";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import {
  FLIPDESK_PHOTO_TYPES,
  isNonListablePhotoType,
  FLIPDESK_PLANS,
  MEASUREMENT_PHOTO_TYPES,
  PHOTO_TYPE_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

// FlipDesk AutoLister (US-316 upload + US-317 grouping). Dump a folder of
// photos, group them so each group = one item/listing, then Generate — which
// materializes each group into an inventory item + photos and kicks off the
// batch AI generation (US-313 backend), landing on the queue view (US-318).
//
// Generation is metered + premium-gated server-side (US-323). The quota/tier
// gate surfaces through edgeFetch's 402 handling, so we don't duplicate it here.

// US-1542: StagedPhoto (and the whole upload pipeline) moved to the app-level
// store so uploads survive in-app navigation. The page consumes the store's
// task list for progress UI and claims finished photos into `staged`.

// US-533: per-photo gallery roles. The cover is always "front"; the rest carry
// a role the AI assigns (and the user can override). US-1551: the role
// vocabulary is now the FULL canonical photo-type set (measurements, tag_2,
// detail_2…, interior, universal roles, …) so a photo can be tagged here
// exactly like in the photo manager / iOS — the AI still only ASSIGNS the
// basic five (AI_ASSIGNABLE_ROLES); everything else is user-set and survives
// the AI pass. US-1549: "internal" marks a seller-reference shot (the price
// tag you paid) — it generates with photo_type 'internal', which the edge
// excludes from eBay, AI passes, and public surfaces; it sorts last and is
// never sent to the classify/verify vision calls from here either.
type PhotoRole = (typeof FLIPDESK_PHOTO_TYPES)[number];
// Canonical gallery rank — FLIPDESK_PHOTO_TYPES order IS the sort order
// (front → back → tag → detail → measurements → defect → extras → universal
// → internal), the same rank photo-order.ts derives everywhere else.
const ROLE_ORDER: Record<PhotoRole, number> = Object.fromEntries(
  FLIPDESK_PHOTO_TYPES.map((t, i) => [t, i]),
) as Record<PhotoRole, number>;
// The roles the classify vision call is allowed to (re)assign. Any role
// OUTSIDE this set was necessarily hand-picked by the seller (measurements,
// tag_2, internal, …) — the AI never emits those, so an AI re-tag must not
// clobber them back to "detail".
const AI_ASSIGNABLE_ROLES: ReadonlySet<PhotoRole> = new Set([
  "front",
  "back",
  "tag",
  "detail",
  "defect",
]);
// Role-select layout: the basic four first, then measurements, then the rest
// of the canonical order (extras + universal), with internal kept last.
// Derived from constants so a new photo type shows up here automatically.
const CORE_ROLE_OPTIONS: PhotoRole[] = ["back", "tag", "detail", "defect"];
const MORE_ROLE_OPTIONS: PhotoRole[] = FLIPDESK_PHOTO_TYPES.filter(
  (t) =>
    t !== "front" &&
    t !== "internal" &&
    !CORE_ROLE_OPTIONS.includes(t) &&
    !(MEASUREMENT_PHOTO_TYPES as readonly string[]).includes(t),
);

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
  // US-1543: true once the seller hand-placed photos (drag-reorder or a
  // positional drop): generate() then writes the photoIds order as sort_order
  // (cover still first) instead of the role-derived order. Roles are kept.
  manualOrder?: boolean;
}

// US-1544: one AI grouping suggestion, as returned by /verify-groups plus a
// client key for dismissal.
interface GroupSuggestionRow {
  id: string;
  type: "merge" | "split" | "move";
  /** merge: [a, b] · split: [group] · move: [from, to]. */
  group_ids: string[];
  photo_ids: string[];
  confidence: number;
  reason: string;
}

// US-1903: one group's verify payload (server-sampled photos) plus the count
// the windowing helper packs against.
interface VerifyWindowGroup {
  id: string;
  photos: { id: string; storage_path: string }[];
  photoCount: number;
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

// US-1550: user-selectable ungrouped-grid ordering. "shooting" is the US-1540
// provenance sort the auto-grouper mirrors; the rest exist because EXIF-less
// exports make "shooting order" meaningless and the seller then needs a
// predictable order to group against (and to recover after an Ungroup).
type UngroupedSortMode = "shooting" | "name" | "date" | "upload";
const UNGROUPED_SORT_KEY = "flipdesk-autolister-ungrouped-sort";
const GROUP_EVERY_KEY = "flipdesk-autolister-group-every";
const UNGROUPED_SORT_LABELS: Record<UngroupedSortMode, string> = {
  shooting: "Shooting order",
  name: "File name",
  date: "Date taken",
  upload: "Upload order",
};

// US-1541: windowed rendering for the two unbounded sections. A 600-photo
// session used to mount every thumbnail tile (and every group card) at once —
// the initial render froze the tab. Only the first chunk mounts; scrolling the
// sentinel into view raises the window. 105 is divisible by the grid's 3/5/7
// column counts, so every breakpoint windows on full rows.
const GRID_CHUNK = 105;
const GROUPS_CHUNK = 24;
// Cap on visible per-file upload rows — 600 progress bars is its own jank.
// Errors always render (they need action); the aggregate header carries totals.
const UPLOAD_ROWS_CAP = 80;

function LoadMoreSentinel({
  label,
  onMore,
}: {
  label: string;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore();
      },
      // Start mounting the next chunk well before the user reaches the end.
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onMore]);
  return (
    <div ref={ref} className="py-2 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

// ── US-1543: drag-and-drop grouping workbench pieces ─────────────────

/**
 * One photo tile as a drag source (via the GripVertical handle — the
 * photo-manager pattern, so the tile's own buttons keep working and the handle
 * is the keyboard-operable a11y affordance: focus it, Space lifts, arrows
 * move, Space drops) and, inside a group, a positional drop target so dropping
 * ON a tile inserts there (reorder / cross-group placement).
 */
function PhotoDragTile({
  photoId,
  groupId,
  className,
  children,
}: {
  photoId: string;
  /** null = the tile lives in the Ungrouped grid. */
  groupId: string | null;
  className?: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: photoId, data: { fromGroupId: groupId } });
  // Ungrouped tiles aren't positional targets — their order is sort-derived
  // (US-1540/US-1550), so dropping "between" them means nothing.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `photo:${photoId}`,
    data: { groupId },
    disabled: groupId == null,
  });
  return (
    <div
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      className={cn(
        className,
        isDragging && "opacity-40",
        groupId != null && isOver && "ring-2 ring-primary",
      )}
    >
      {children}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={groupId == null ? "Drag to add to a group" : "Drag to move or reorder"}
        title="Drag to move"
        className="absolute left-1 top-7 z-10 cursor-grab rounded bg-black/55 p-1 text-white opacity-0 focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100"
      >
        <GripVertical className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Non-pointer fallback for moving a photo: a "Move to…" menu (US-1543 AC3). */
function MovePhotoMenu({
  photoId,
  currentGroupId,
  groups,
  onMove,
  onNewGroup,
  className,
}: {
  photoId: string;
  currentGroupId: string | null;
  groups: Group[];
  onMove: (photoId: string, targetGroupId: string | null) => void;
  onNewGroup: (photoId: string) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Move to group"
          title="Move to group…"
          className={cn(
            "z-10 rounded-full bg-black/55 p-1 text-white opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            className,
          )}
        >
          <FolderInput className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 w-56 overflow-y-auto">
        <DropdownMenuLabel>Move photo to</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onNewGroup(photoId)}>New group</DropdownMenuItem>
        {currentGroupId != null && (
          <DropdownMenuItem onClick={() => onMove(photoId, null)}>
            Ungrouped
          </DropdownMenuItem>
        )}
        {groups.some((g) => g.id !== currentGroupId) && <DropdownMenuSeparator />}
        {groups
          .filter((g) => g.id !== currentGroupId)
          .map((g) => (
            <DropdownMenuItem key={g.id} onClick={() => onMove(photoId, g.id)}>
              <span className="truncate">{g.name || "Untitled group"}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A group card as a drop target: dropping anywhere on it appends the photos. */
function GroupDropZone({ groupId, children }: { groupId: string; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: `group:${groupId}` });
  return (
    <div
      ref={setNodeRef}
      // US-1546: scroll anchor for the checkpoint's warning links.
      id={`group-card-${groupId}`}
      className={cn("rounded-xl", isOver && "ring-2 ring-primary/60")}
    >
      {children}
    </div>
  );
}

/** The Ungrouped section as a drop target: dropping here ungroups the photos. */
function UngroupedDropZone({ children }: { children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: "ungrouped" });
  return (
    <div ref={setNodeRef} className={cn("rounded-lg", isOver && "ring-2 ring-primary/60")}>
      {children}
    </div>
  );
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

  // US-1545: the month's remaining AI actions (plan cap, tightened by the
  // optional self-cap) — feeds the projected-spend line next to Generate. The
  // server enforces the same math at enqueue (count-aware 402) and per item.
  const aiActionsRemaining = useMemo(() => {
    if (!billing) return null;
    const planCap = FLIPDESK_PLANS[plan].aiActionsPerMonth;
    const selfCap = billing.usage.ai_action_limit;
    const limit = selfCap != null ? Math.min(planCap, selfCap) : planCap;
    return Math.max(0, limit - billing.usage.ai_actions_used_this_month);
  }, [billing, plan]);

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
  // US-1550: shift-click range selection anchor (id of the last plain click).
  const selectAnchorRef = useRef<string | null>(null);
  // US-1550: grid sort mode + the "group every N" chunk size, both remembered
  // across sessions (a 600-photo intake spans many visits).
  const [ungroupedSort, setUngroupedSort] = useState<UngroupedSortMode>(() => {
    try {
      const v = localStorage.getItem(UNGROUPED_SORT_KEY);
      if (v === "shooting" || v === "name" || v === "date" || v === "upload") return v;
    } catch {
      // ignore — default below
    }
    return "shooting";
  });
  const [groupEvery, setGroupEvery] = useState(() => {
    try {
      const v = Number.parseInt(localStorage.getItem(GROUP_EVERY_KEY) ?? "", 10);
      if (Number.isFinite(v) && v >= 1 && v <= 24) return v;
    } catch {
      // ignore — default below
    }
    return 4;
  });
  // US-1541: windowed-rendering limits (raised by the LoadMoreSentinels).
  const [ungroupedLimit, setUngroupedLimit] = useState(GRID_CHUNK);
  const [groupsLimit, setGroupsLimit] = useState(GROUPS_CHUNK);
  // Group ids created by the LAST auto-group run so it can be undone as one
  // action (those photos return to Ungrouped; manually-made groups survive).
  // In-memory only: a mis-grouped but persisted session is reset via
  // "Ungroup all" instead.
  const [lastAutoGroupIds, setLastAutoGroupIds] = useState<string[] | null>(
    null,
  );
  // US-539/US-1542: per-file pipeline tasks (progress bars + failure retry)
  // now live in the app-level store, so uploads survive in-app navigation and
  // this page just renders live progress + claims finished photos.
  const uploadTasks = useAutolisterUploadStore((s) => s.tasks);
  const uploadResults = useAutolisterUploadStore((s) => s.results);
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
  // US-1544: AI group-boundary suggestions (merge/split/move). NEVER
  // auto-applied — rendered as dismissible chips on the affected groups.
  const [groupSuggestions, setGroupSuggestions] = useState<GroupSuggestionRow[]>([]);
  const [verifyingGroups, setVerifyingGroups] = useState(false);
  // US-1903: the explicit "Verify groups" pass walks ALL groups across
  // sequential windows (one /verify-groups call each). Progress is shown while
  // windows run and is cancellable between windows; a >1-window pass asks for
  // confirmation first (each window is one metered AI action).
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);
  const verifyCancelRef = useRef(false);
  const [verifyConfirm, setVerifyConfirm] = useState<
    | { windows: VerifyWindowGroup[][]; windowCount: number; totalGroups: number }
    | null
  >(null);
  // US-1546: pre-generate checkpoint — Generate opens this confirm dialog;
  // when photos would be left ungrouped, an explicit acknowledgment gates it.
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);
  const [ackUngrouped, setAckUngrouped] = useState(false);
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

  // US-1542: page ↔ upload-store wiring.
  //
  // Attach/detach: while attached the store skips its own localStorage merge
  // (this page claims results + persists them itself). Detaching hands that
  // responsibility back so uploads finishing mid-navigation are still safe
  // against a hard reload.
  useEffect(() => {
    // sessionId is a ref — stable for the component's lifetime.
    const store = useAutolisterUploadStore.getState();
    store.attach(sessionId.current);
    return () => useAutolisterUploadStore.getState().detach();
  }, []);

  // Duplicate guards: mirror the staged photos' source signatures/hashes into
  // the store (deleting a photo frees its identity for re-adding; a claim that
  // made it into `staged` is pruned store-side).
  useEffect(() => {
    const sigs = new Set<string>();
    const hashes = new Set<string>();
    for (const p of staged) {
      if (p.sourceSig) sigs.add(p.sourceSig);
      if (p.sourceHash) hashes.add(p.sourceHash);
    }
    useAutolisterUploadStore.getState().syncStagedIdentities(sigs, hashes);
  }, [staged]);

  // Claim finished photos from the store into the page's staged state (deduped
  // by id — a photo merged into localStorage while this page was unmounted may
  // already have rehydrated).
  useEffect(() => {
    if (uploadResults.length === 0) return;
    setStaged((prev) => {
      const have = new Set(prev.map((p) => p.id));
      const fresh = uploadResults.filter((r) => !have.has(r.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    useAutolisterUploadStore.getState().claimResults(uploadResults.map((r) => r.id));
  }, [uploadResults]);

  // US-1542 AC3: after a hard reload, Files queued in the previous page life
  // are unrecoverable — say plainly how many need re-adding.
  useEffect(() => {
    const lost = useAutolisterUploadStore.getState().consumeLostUploadCount();
    if (lost > 0) {
      toast.warning(
        `${lost} photo${lost === 1 ? "" : "s"} didn't finish uploading before the page closed.`,
        {
          description:
            "Already-uploaded photos are safe below — add the missing files again to finish.",
          duration: 10_000,
        },
      );
    }
  }, []);

  // Persist whenever staged / groups change. US-1541: size-guarded — a 600-
  // photo session's JSON is normally well under quota, but the per-photo
  // `original` snapshots (pre-edit revert data) can inflate it. On a quota
  // error, degrade gracefully: retry WITHOUT the snapshots (losing only the
  // ability to revert edits after a reload), and warn once instead of
  // silently dropping session recovery.
  const persistWarnedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ staged, groups }),
      );
      return;
    } catch {
      /* fall through to the slimmed retry */
    }
    try {
      const slimmed = staged.map((p) => {
        const copy = { ...p };
        delete copy.original;
        return copy;
      });
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ staged: slimmed, groups }),
      );
      if (!persistWarnedRef.current) {
        persistWarnedRef.current = true;
        toast.warning(
          "This session is too large to save fully — it will still restore after a reload, but photo-edit undo snapshots won't.",
        );
      }
    } catch {
      if (!persistWarnedRef.current) {
        persistWarnedRef.current = true;
        toast.warning(
          "Couldn't save this session locally (storage is full or disabled) — a reload will lose the grouping. Uploaded photos are safe on the server.",
        );
      }
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
  const ungrouped = useMemo(
    () => staged.filter((p) => !groupedIds.has(p.id)),
    [staged, groupedIds],
  );
  // US-1550: the grid's sort is user-selectable again. "Shooting order" (the
  // US-1540 provenance sort: capture time → filename sequence → upload order)
  // stays the default because it previews the boundaries auto-grouping will
  // use — but exports often strip EXIF, and then the seller needs to see (and
  // group across) their own order: by file name, by date taken, or exactly as
  // uploaded. Every sort is stable, so ties keep the staged (upload) order.
  const ungroupedSorted = useMemo(() => {
    if (ungroupedSort === "upload") return ungrouped;
    if (ungroupedSort === "name") {
      const wrapped = ungrouped.map((p) => ({ p, name: stagedSortName(p) }));
      // Natural compare so IMG_9 < IMG_10; unnamed photos sink to the end.
      wrapped.sort((a, b) => {
        if (a.name != null && b.name != null) {
          return a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }
        if (a.name != null) return -1;
        if (b.name != null) return 1;
        return 0;
      });
      return wrapped.map((w) => w.p);
    }
    if (ungroupedSort === "date") {
      const timeOf = (p: StagedPhoto) =>
        p.capturedAtMs ?? Number.POSITIVE_INFINITY;
      // Unknown dates sink to the end (both-unknown ties keep upload order —
      // never subtract two Infinities, that's NaN).
      return [...ungrouped].sort((a, b) => {
        const ta = timeOf(a);
        const tb = timeOf(b);
        return ta === tb ? 0 : ta - tb;
      });
    }
    const wrapped = ungrouped.map((p) => ({
      p,
      key: {
        capturedAt: p.capturedAtMs != null ? new Date(p.capturedAtMs) : null,
        sourceName: stagedSortName(p),
      },
    }));
    wrapped.sort((a, b) => compareByProvenance(a.key, b.key));
    return wrapped.map((w) => w.p);
  }, [ungrouped, ungroupedSort]);

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
    // US-1911: the hook chunks `pending` to the server's ≤100-per-request cap
    // and merges partials as each chunk resolves. onSettled clears in-flight for
    // ALL pending covers — including any left unscored by a failed chunk — so a
    // later intake pass (triggered when the grouping changes) retries them.
    coverQa.mutate(
      {
        covers: pending,
        onPartial: (results) => {
          setCoverScores((prev) => {
            const next = { ...prev };
            for (const r of results) next[r.cover_id] = r.score;
            return next;
          });
        },
      },
      {
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

  // US-1542: the upload pipeline itself (dedup -> EXIF -> normalize ->
  // compress -> validate -> paced upload) lives in the app-level store — see
  // src/stores/autolister-upload-store.ts. These are thin delegates so the
  // existing JSX call sites stay unchanged.
  async function handleFiles(files: FileList | File[] | null) {
    if (!files || !ownerId) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    await useAutolisterUploadStore
      .getState()
      .enqueueFiles(list, sessionId.current);
  }

  // US-539: re-run failed pipelines without re-picking files.
  async function retryUploadTasks(taskIds: string[]) {
    await useAutolisterUploadStore.getState().retryTasks(taskIds);
  }

  function dismissUploadTask(id: string) {
    useAutolisterUploadStore.getState().dismissTask(id);
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

  // US-1550: remember the chosen grid sort (see `ungroupedSorted`, which
  // renders it; unlike the pre-US-1540 sort buttons this never rewrites the
  // staged order, so "Upload order" always recovers the original sequence).
  useEffect(() => {
    try {
      localStorage.setItem(UNGROUPED_SORT_KEY, ungroupedSort);
      if (Number.isFinite(groupEvery) && groupEvery >= 1 && groupEvery <= 24) {
        localStorage.setItem(GROUP_EVERY_KEY, String(groupEvery));
      }
    } catch {
      // best-effort persistence only
    }
  }, [ungroupedSort, groupEvery]);

  // US-1550: shift-click selects the whole range between the last plain click
  // and this one, in the grid's CURRENT displayed order — the only sane way to
  // hand-group a several-hundred-photo dump.
  function toggleSelect(id: string, shiftKey = false) {
    const anchor = selectAnchorRef.current;
    if (shiftKey && anchor && anchor !== id) {
      const order = ungroupedSorted.map((p) => p.id);
      const i = order.indexOf(anchor);
      const j = order.indexOf(id);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i < j ? [i, j] : [j, i];
        setSelected((prev) => {
          const next = new Set(prev);
          for (const pid of order.slice(lo, hi + 1)) next.add(pid);
          return next;
        });
        selectAnchorRef.current = id;
        return;
      }
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    selectAnchorRef.current = id;
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

  // ── US-1543: undoable grouping mutations + drag-and-drop ───────────

  /** Snapshot for single-level undo of the LAST grouping mutation. */
  const undoGroupsRef = useRef<Group[] | null>(null);
  // US-1908: the auto-grouper's assignment (photoId → group id) and the ids of
  // the groups it created, captured at Auto-group time. The correction score at
  // generate compares these against the final grouping.
  const autoAssignedRef = useRef<Record<string, string>>({});
  const autoGroupIdsRef = useRef<Set<string>>(new Set());

  /**
   * Apply a grouping mutation with single-level undo: snapshots the previous
   * groups and offers Undo on the toast. `apply` must return the SAME array
   * reference on a no-op (the autolister-group-edits helpers do) so nothing is
   * snapshotted or toasted for nothing. Returns whether it applied.
   */
  function applyGroupEdit(
    label: string,
    apply: (prev: Group[]) => Group[],
    kind?: GroupEditKind,
  ): boolean {
    const next = apply(groups);
    if (next === groups) return false;
    undoGroupsRef.current = groups;
    setGroups(next);
    // US-1908: measure how much sellers correct the auto-grouper.
    if (kind) trackGroupEdit(kind);
    toast.success(label, {
      action: { label: "Undo", onClick: undoLastGroupEdit },
    });
    return true;
  }

  function undoLastGroupEdit() {
    const snapshot = undoGroupsRef.current;
    if (!snapshot) return;
    undoGroupsRef.current = null;
    setGroups(snapshot);
    // Group ids may have come or gone — reset the group selection to be safe.
    setSelectedGroups(new Set());
    toast.success("Grouping change undone.");
  }

  const groupNameOf = (id: string | null) =>
    id == null ? "Ungrouped" : (groups.find((g) => g.id === id)?.name || "the group");

  /** Move photos (drag or menu). Clears the photo selection on success. */
  function movePhotos(
    photoIds: string[],
    targetGroupId: string | null,
    beforePhotoId: string | null = null,
  ) {
    const label =
      `Moved ${photoIds.length === 1 ? "photo" : `${photoIds.length} photos`} to ` +
      `${groupNameOf(targetGroupId)}.`;
    if (
      applyGroupEdit(
        label,
        (prev) => movePhotosToGroup(prev, photoIds, targetGroupId, beforePhotoId),
        "move",
      )
    ) {
      setSelected(new Set());
    }
  }

  /** "New group" from the move menu: pull the photo out of any group first. */
  function newGroupFromPhoto(photoId: string) {
    applyGroupEdit(
      "New group created.",
      (prev) => {
        const cleared = movePhotosToGroup(prev, [photoId], null);
        return [
          ...cleared,
          {
            id: crypto.randomUUID(),
            name: `Item ${prev.length + 1}`,
            photoIds: [photoId],
            coverId: photoId,
          },
        ];
      },
      "split",
    );
  }

  // ── US-1544: AI group-boundary verification ────────────────────────

  /**
   * Build the server-sampled verify payload for the eligible groups. Internal
   * (seller-reference) and measurement photos stay out of the vision pass
   * (US-1549/US-1571). Groups with no listable photo are dropped.
   */
  function buildVerifyPayload(checkGroups: Group[]): VerifyWindowGroup[] {
    return checkGroups
      .filter((g) => g.photoIds.length > 0)
      .map((g) => {
        const photos = g.photoIds
          .filter((pid) => !isNonListablePhotoType(g.roles?.[pid] ?? "detail"))
          .map((pid) => stagedById.get(pid))
          .filter((p): p is StagedPhoto => !!p)
          .map((p) => ({ id: p.id, storage_path: p.storagePath }));
        return { id: g.id, photos, photoCount: photos.length };
      })
      .filter((g) => g.photos.length > 0);
  }

  /**
   * US-1903: walk `windows` sequentially — one /verify-groups call each — so a
   * large session gets EVERY group checked, not just the first ~13. Progress is
   * shown for a multi-window pass and the run is cancellable between windows;
   * suggestions aggregate across windows and dedupe by (type, group_ids,
   * photo_ids) before rendering. Each window is one metered AI action.
   */
  async function runVerifyWindows(windows: VerifyWindowGroup[][], silent: boolean) {
    if (windows.length === 0) return;
    const multi = windows.length > 1;
    const totalGroups = windows.reduce((n, w) => n + w.length, 0);
    setVerifyingGroups(true);
    verifyCancelRef.current = false;
    setVerifyProgress(multi ? { done: 0, total: totalGroups } : null);
    const collected: GroupSuggestionRow[] = [];
    let done = 0;
    let anyError = false;
    try {
      for (const window of windows) {
        if (verifyCancelRef.current) break;
        try {
          const res = await edgeFetch("/api/flipdesk/autolister/verify-groups", {
            method: "POST",
            json: { groups: window.map((g) => ({ id: g.id, photos: g.photos })) },
          });
          const json = (await res.json().catch(() => ({}))) as {
            suggestions?: Array<Omit<GroupSuggestionRow, "id">>;
            error?: string;
          };
          if (!res.ok) {
            anyError = true;
            if (!silent && !multi) toast.error(json.error || "Could not verify the grouping.");
          } else {
            for (const s of json.suggestions ?? []) {
              collected.push({ ...s, id: crypto.randomUUID() });
            }
          }
        } catch (err) {
          anyError = true;
          if (!silent && !multi) {
            toast.error(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        done += window.length;
        if (multi) setVerifyProgress({ done, total: totalGroups });
      }

      const deduped = dedupeSuggestions(collected);
      // Don't clobber existing chips if the whole pass errored with nothing to
      // show; otherwise the fresh result (even empty) replaces the old chips.
      if (!(anyError && deduped.length === 0)) setGroupSuggestions(deduped);

      if (verifyCancelRef.current) {
        if (!silent) toast.info(`Stopped — checked ${done} of ${totalGroups} groups.`);
      } else if (deduped.length > 0) {
        toast.info(
          `AI flagged ${deduped.length} possible grouping fix${deduped.length === 1 ? "" : "es"} — review the highlighted groups.`,
        );
      } else if (!silent && anyError) {
        toast.error("Some groups couldn't be checked — try again.");
      } else if (!silent) {
        toast.success("The grouping looks right to the AI.");
      }
    } finally {
      setVerifyingGroups(false);
      setVerifyProgress(null);
    }
  }

  /**
   * On-demand AI grouping sanity check. Suggestions come back as dismissible
   * chips — never auto-applied. `checkGroups` lets autoGroup() verify the groups
   * it JUST created (state not committed yet).
   *
   * The silent auto-run after auto-group stays single-window/cheap (one AI
   * action). The explicit pass covers ALL groups: if it needs more than one
   * window it first asks the seller to confirm the metered-action count.
   */
  async function verifyGroups(silent: boolean, checkGroups: Group[] = groups) {
    if (verifyingGroups) return;
    const eligible = checkGroups.filter((g) => g.photoIds.length > 0);
    if (eligible.length < 2) {
      if (!silent) toast.info("Group at least two items first — then AI can compare them.");
      return;
    }
    const payloadGroups = buildVerifyPayload(checkGroups);
    if (payloadGroups.length < 2) return;
    const windows = planVerifyWindows(payloadGroups, MAX_VERIFY_SAMPLE_PHOTOS);
    if (windows.length === 0) return;
    if (silent) {
      // Cheap as before: only the first window runs automatically.
      await runVerifyWindows([windows[0]!], true);
      return;
    }
    if (windows.length > 1) {
      // Show the metered-action count up front before spending it.
      setVerifyConfirm({
        windows,
        windowCount: windows.length,
        totalGroups: payloadGroups.length,
      });
      return;
    }
    await runVerifyWindows(windows, false);
  }

  /** Suggestions to chip onto group `gid` (move chips only on the source). */
  function suggestionsFor(gid: string): GroupSuggestionRow[] {
    return groupSuggestions.filter((s) =>
      s.type === "move" ? s.group_ids[0] === gid : s.group_ids.includes(gid),
    );
  }

  function suggestionLabel(s: GroupSuggestionRow, gid: string): string {
    const nameOf = (id: string | undefined) =>
      groups.find((g) => g.id === id)?.name || "another group";
    const n = s.photo_ids.length;
    if (s.type === "merge") {
      return `Same item as ${nameOf(s.group_ids.find((id) => id !== gid))} — merge?`;
    }
    if (s.type === "split") {
      return `May contain two items — split ${n} photo${n === 1 ? "" : "s"} out?`;
    }
    return `Move ${n} photo${n === 1 ? "" : "s"} to ${nameOf(s.group_ids[1])}?`;
  }

  /** Remove a suggestion chip without telemetry (used by apply). */
  function removeSuggestion(id: string) {
    setGroupSuggestions((prev) => prev.filter((s) => s.id !== id));
  }

  /** User dismissed a suggestion via its ✕ — US-1908 records it as feedback. */
  function dismissSuggestion(id: string) {
    const s = groupSuggestions.find((x) => x.id === id);
    removeSuggestion(id);
    if (s) trackAiSuggestion({ source: "verify", action: "dismissed", confidence: s.confidence });
  }

  // ── US-1546: pre-generate checkpoint ───────────────────────────────

  /** Groups that will actually generate (non-empty). */
  const listableCount = groups.filter((g) => g.photoIds.length > 0).length;

  /** US-1546 AC2: suspicious groups, each linkable/scrollable. */
  interface GroupWarning {
    key: string;
    groupId: string;
    label: string;
  }
  const groupWarnings = useMemo<GroupWarning[]>(() => {
    const warnings: GroupWarning[] = [];
    const nameOf = (g: Group) => g.name || "Untitled group";
    for (const g of groups) {
      if (g.photoIds.length === 1) {
        warnings.push({
          key: `single-${g.id}`,
          groupId: g.id,
          label: `“${nameOf(g)}” has a single photo`,
        });
      } else if (g.photoIds.length > 12) {
        warnings.push({
          key: `big-${g.id}`,
          groupId: g.id,
          label: `“${nameOf(g)}” has ${g.photoIds.length} photos — two items?`,
        });
      }
      const score = coverScores[g.coverId];
      if (score != null && score >= 0 && score < COVER_QA_REVIEW_THRESHOLD) {
        warnings.push({
          key: `cover-${g.id}`,
          groupId: g.id,
          label: `“${nameOf(g)}” cover scored ${score} — reshoot recommended`,
        });
      }
    }
    // Unresolved US-1544 AI suggestions count as open questions.
    for (const s of groupSuggestions) {
      const g = groups.find((x) => x.id === s.group_ids[0]);
      if (!g) continue;
      warnings.push({
        key: `ai-${s.id}`,
        groupId: g.id,
        label: `AI suggestion open on “${nameOf(g)}” (${s.type})`,
      });
    }
    return warnings;
  }, [groups, coverScores, groupSuggestions]);

  /** Scroll to a group card, raising the render window when it's beyond it. */
  function scrollToGroup(groupId: string) {
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx >= 0 && idx >= groupsLimit) {
      setGroupsLimit(Math.ceil((idx + 1) / GROUPS_CHUNK) * GROUPS_CHUNK);
    }
    setConfirmGenerateOpen(false);
    // Let the window expansion commit before scrolling.
    setTimeout(() => {
      document
        .getElementById(`group-card-${groupId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  /** Generate button → checkpoint dialog (the button's own disabled state
   * already enforces the busy / no-groups / uploads-in-flight / entitlement
   * gates, so opening never bypasses them). */
  function openGenerateConfirm() {
    setAckUngrouped(false);
    setConfirmGenerateOpen(true);
  }

  /** Apply one suggestion via the US-1543 undoable mutations. */
  function applySuggestion(s: GroupSuggestionRow) {
    // US-1908: an applied suggestion is grouping feedback (source verify — the
    // only suggestion source today; US-1904 propose will pass "propose").
    trackAiSuggestion({ source: "verify", action: "applied", confidence: s.confidence });
    if (s.type === "merge") {
      mergeGroups([s.group_ids[0]!, s.group_ids[1]!]);
    } else if (s.type === "move") {
      movePhotos(s.photo_ids, s.group_ids[1] ?? null);
    } else {
      applyGroupEdit(
        `Split ${s.photo_ids.length} photo${s.photo_ids.length === 1 ? "" : "s"} into a new group.`,
        (prev) => {
          const pulled = movePhotosToGroup(prev, s.photo_ids, null);
          return [
            ...pulled,
            {
              id: crypto.randomUUID(),
              name: `Item ${prev.length + 1}`,
              photoIds: s.photo_ids,
              coverId: s.photo_ids[0]!,
            },
          ];
        },
        "split",
      );
    }
    // Not dismissSuggestion — applying isn't a dismissal (no double event).
    removeSuggestion(s.id);
  }

  // US-1543 sensors: the drag handle is a real button, so the pointer sensor
  // needs a small travel threshold (a plain click still focuses/does nothing
  // destructive) and the keyboard sensor makes it operable without a pointer.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function onGroupDragEnd(e: DragEndEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const fromGroupId =
      (e.active.data.current as { fromGroupId?: string | null } | undefined)
        ?.fromGroupId ?? null;
    // Multi-select drag: dragging a selected tile moves the whole selection.
    const movingIds = selected.has(activeId) ? Array.from(selected) : [activeId];

    if (overId === "ungrouped") {
      movePhotos(movingIds, null);
      return;
    }
    if (overId.startsWith("group:")) {
      movePhotos(movingIds, overId.slice("group:".length));
      return;
    }
    if (overId.startsWith("photo:")) {
      const anchorId = overId.slice("photo:".length);
      if (anchorId === activeId) return;
      const targetGroupId =
        (e.over?.data.current as { groupId?: string | null } | undefined)?.groupId ??
        null;
      if (!targetGroupId) return;
      if (movingIds.length === 1 && fromGroupId === targetGroupId) {
        applyGroupEdit(
          "Photo order updated.",
          (prev) => reorderWithinGroup(prev, targetGroupId, activeId, anchorId),
          "reorder",
        );
      } else {
        movePhotos(movingIds, targetGroupId, anchorId);
      }
    }
  }

  function createGroupFromSelection() {
    // US-1550: order the new group by the grid's displayed order, not by the
    // click order the Set happens to remember (range selection makes click
    // order meaningless).
    const orderIndex = new Map(ungroupedSorted.map((p, i) => [p.id, i]));
    const ids = Array.from(selected)
      .filter((id) => !groupedIds.has(id))
      .sort((x, y) => (orderIndex.get(x) ?? 0) - (orderIndex.get(y) ?? 0));
    if (ids.length === 0) return;
    applyGroupEdit(
      `Group created from ${ids.length} photo${ids.length === 1 ? "" : "s"}.`,
      (prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: `Item ${prev.length + 1}`,
          photoIds: ids,
          coverId: ids[0]!,
        },
      ],
      "split",
    );
    setSelected(new Set());
  }

  // US-532: auto-group the ungrouped photos into per-item listings by EXIF
  // capture-time bursts + a dHash visual second pass (US-1540: photos without
  // capture time group by camera filename sequence instead of all becoming
  // singletons). Existing manual groups are preserved; detected groups are
  // appended so the user can then merge/split.
  function autoGroup() {
    const input: GroupablePhoto[] = ungrouped.map((p) => ({
      id: p.id,
      capturedAt: p.capturedAtMs != null ? new Date(p.capturedAtMs) : null,
      phash: p.phash,
      sourceName: stagedSortName(p),
    }));
    if (input.length === 0) return;
    const auto = autoGroupPhotos(input);
    // Mint the ids up front so this run is undoable as a unit.
    const created = auto.map((g, i) => ({
      id: crypto.randomUUID(),
      name: `Item ${groups.length + i + 1}`,
      photoIds: g.photoIds,
      coverId: g.coverId,
    }));
    const createdIds = created.map((g) => g.id);
    setGroups((prev) => [...prev, ...created]);
    setLastAutoGroupIds(createdIds);
    setSelected(new Set());
    // US-1908: snapshot the auto-assignment for the generate-time correction
    // score, and record this run's metrics (counts only — no image data /
    // filenames). Fires even on the degenerate branch below (that's signal too).
    for (const g of created) {
      autoGroupIdsRef.current.add(g.id);
      for (const pid of g.photoIds) autoAssignedRef.current[pid] = g.id;
    }
    const withExif = input.filter((p) => p.capturedAt != null).length;
    const seqSeeded = sequenceRuns(input)
      .filter((run) => run.length >= 2)
      .reduce((n, run) => n + run.length, 0);
    trackAutogroupRun({
      photo_count: input.length,
      group_count: auto.length,
      singleton_count: auto.filter((g) => g.photoIds.length === 1).length,
      pct_with_exif: input.length === 0 ? 0 : Math.round((withExif / input.length) * 100) / 100,
      seq_seeded_count: seqSeeded,
    });
    // Degenerate grouping (photos without capture times or usable filename
    // sequences collapse into one giant burst): warn instead of celebrating,
    // and lead with Undo — grouping manually from the (shooting-ordered) grid
    // beats untangling a 500-photo item. The toast closes over createdIds
    // directly (the state set above isn't visible to this render's closures).
    const biggest = Math.max(...auto.map((g) => g.photoIds.length));
    if (input.length >= 12 && biggest >= input.length * 0.8) {
      toast.warning(
        `Auto-group put ${biggest} of ${input.length} photos into one item — the photos may be missing capture times. Undo, then group manually (the grid is in shooting order).`,
        {
          action: { label: "Undo", onClick: () => undoAutoGroup(createdIds) },
          duration: 12000,
        },
      );
      return;
    }
    toast.success(
      `Auto-grouped ${input.length} photo${input.length === 1 ? "" : "s"} into ${auto.length} item${auto.length === 1 ? "" : "s"}. Tweak as needed.`,
      { action: { label: "Undo", onClick: () => undoAutoGroup(createdIds) } },
    );
    // US-1544: sanity-check the freshly-created grouping (silent — only
    // speaks up when it finds something). Skipped in the degenerate branch
    // above, where the user is being told to undo anyway.
    void verifyGroups(true, [...groups, ...created]);
  }

  // US-1550: chunk the grid into fixed-size groups, in the grid's CURRENT
  // displayed order. The rescue tool for dumps auto-grouping can't read
  // (EXIF stripped, one contiguous filename run): sellers who shoot a fixed
  // number of photos per item sort by name/upload and cut every N. Undoable
  // as one run, exactly like Auto-group.
  function groupEveryN() {
    const n = Math.floor(groupEvery);
    if (!Number.isFinite(n) || n < 1 || ungroupedSorted.length === 0) return;
    const created: Group[] = [];
    for (let i = 0; i < ungroupedSorted.length; i += n) {
      const chunk = ungroupedSorted.slice(i, i + n);
      created.push({
        id: crypto.randomUUID(),
        name: `Item ${groups.length + created.length + 1}`,
        photoIds: chunk.map((p) => p.id),
        coverId: chunk[0]!.id,
      });
    }
    const createdIds = created.map((g) => g.id);
    setGroups((prev) => [...prev, ...created]);
    setLastAutoGroupIds(createdIds);
    setSelected(new Set());
    // US-1908: a manual bulk-group action (not the auto-grouper).
    trackGroupEdit("group_every");
    toast.success(
      `Grouped ${ungroupedSorted.length} photos into ${created.length} item${created.length === 1 ? "" : "s"} of ${n}, following the grid's current order (${UNGROUPED_SORT_LABELS[ungroupedSort].toLowerCase()}).`,
      { action: { label: "Undo", onClick: () => undoAutoGroup(createdIds) } },
    );
  }

  // Undo the LAST auto-group run: dissolve exactly the groups it created (their
  // photos return to Ungrouped). Groups made by hand — before or after — stay.
  // `ids` defaults to the tracked run for the toolbar button; the toast action
  // passes its run's ids explicitly (its closure predates the state update).
  function undoAutoGroup(ids: string[] | null = lastAutoGroupIds) {
    if (!ids || ids.length === 0) return;
    const idSet = new Set(ids);
    setGroups((prev) => prev.filter((g) => !idSet.has(g.id)));
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setLastAutoGroupIds(null);
    toast.success("Auto-grouping undone — photos are back in Ungrouped.");
  }

  // Full reset: dissolve EVERY group (photos return to Ungrouped; nothing is
  // deleted). This is the escape hatch when a bad grouping was already
  // persisted to the session (the undo snapshot doesn't survive a reload).
  function ungroupAll() {
    // US-1543: undoable like every other grouping mutation.
    applyGroupEdit(
      "All groups dissolved — photos are back in Ungrouped, in the grid's chosen sort order.",
      (prev) => (prev.length === 0 ? prev : []),
      "ungroup_all",
    );
    setSelectedGroups(new Set());
    setLastAutoGroupIds(null);
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
      // US-1549: never send seller-reference (internal) photos to the vision
      // pass — the AI must not read the price tag you paid.
      .filter((pid) => !isNonListablePhotoType(g.roles?.[pid] ?? "detail"))
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
      // US-1549/US-1551: the AI only assigns the basic five roles, so any role
      // outside that set (internal, measurements, tag_2, …) was hand-picked by
      // the seller — re-apply those over the AI result instead of letting the
      // pass demote them to "detail".
      const preservedManual = Object.fromEntries(
        Object.entries(g.roles ?? {}).filter(
          ([, role]) => !AI_ASSIGNABLE_ROLES.has(role),
        ),
      ) as Record<string, PhotoRole>;
      updateGroup(groupId, {
        coverId: cover,
        roles: { ...(json.roles ?? {}), ...preservedManual },
      });
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
    // US-1543: routed through the shared move transform (cover repair, empty-
    // group dissolution, role pruning) with single-level undo.
    void groupId;
    applyGroupEdit(
      "Photo moved back to Ungrouped.",
      (prev) => movePhotosToGroup(prev, [photoId], null),
      "move",
    );
  }

  function deleteGroup(groupId: string) {
    applyGroupEdit(
      "Group deleted — its photos are back in Ungrouped.",
      (prev) => prev.filter((g) => g.id !== groupId),
      "move",
    );
  }

  // US-317: merge two or more groups. Keeps the first group's name and cover,
  // concatenates the rest's photos. Called when 2+ groups are checkbox-selected
  // via the group toolbar's "Merge selected" action. US-1543: undoable.
  function mergeGroups(groupIds: string[]) {
    if (groupIds.length < 2) return;
    applyGroupEdit(
      `Merged ${groupIds.length} groups.`,
      (prev) => {
        const survivors = prev.filter((g) => !groupIds.includes(g.id));
        const merged = prev.filter((g) => groupIds.includes(g.id));
        if (merged.length < 2) return prev;
        const allIds = Array.from(new Set(merged.flatMap((g) => g.photoIds)));
        const head = merged[0]!;
        const combined: Group = {
          ...head,
          photoIds: allIds,
          coverId: allIds.includes(head.coverId) ? head.coverId : (allIds[0] ?? ""),
        };
        // Preserve the relative order of the first merged group.
        const headIdx = prev.findIndex((g) => g.id === head.id);
        const out = [...survivors];
        out.splice(Math.min(headIdx, out.length), 0, combined);
        return out;
      },
      "merge",
    );
    setSelectedGroups(new Set());
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
    // US-1908: session-end grouping outcome — how much the seller corrected the
    // auto-grouper — captured BEFORE generation mutates anything.
    const finalAssigned: Record<string, string> = {};
    for (const g of groups) for (const pid of g.photoIds) finalAssigned[pid] = g.id;
    const correction = groupingCorrectionScore(autoAssignedRef.current, finalAssigned);
    trackGroupingOutcome({
      photo_count: staged.length,
      corrected_count: correction.corrected,
      correction_pct: Math.round(correction.pct * 100) / 100,
      manual_groups_created: manualGroupsCreated(
        autoGroupIdsRef.current,
        groups.map((g) => g.id),
      ),
    });
    setBusy(true);
    try {
      const itemIds: string[] = [];
      for (const g of groups) {
        const photos = g.photoIds
          .map((pid) => stagedById.get(pid))
          .filter((p): p is StagedPhoto => !!p);
        if (photos.length === 0) continue;

        // US-533: cover first (front), then the rest in the canonical
        // photo-type order (back → tag → detail → measurements → defect →
        // extras; internal last). photo_type carries the assigned role so the
        // eBay gallery is well-ordered and labeled, not all "detail".
        // US-1543: once the seller hand-placed photos (drag-reorder /
        // positional drop), THEIR order wins — it becomes sort_order verbatim
        // (cover still first; roles still label each photo).
        const roleOf = (p: StagedPhoto): PhotoRole =>
          p.id === g.coverId ? "front" : (g.roles?.[p.id] ?? "detail");
        const ordered = [...photos].sort((a, b) => {
          if (a.id === g.coverId) return -1;
          if (b.id === g.coverId) return 1;
          return g.manualOrder
            ? g.photoIds.indexOf(a.id) - g.photoIds.indexOf(b.id)
            : ROLE_ORDER[roleOf(a)] - ROLE_ORDER[roleOf(b)];
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
          // US-1539: photo provenance — the client-read EXIF capture time and
          // the source file's name, persisted as scalars (the stored image
          // bytes stay metadata-stripped) so grouping is reconstructable and
          // filename-sequence grouping survives beyond this session.
          // stagedSortName also recovers the name from sourceSig for photos
          // staged before sourceName existed.
          captured_at: p.capturedAtMs != null ? new Date(p.capturedAtMs).toISOString() : null,
          original_filename: stagedSortName(p),
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
            onClick={openGenerateConfirm}
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
          {/* US-1545: projected AI spend vs the month's remainder, so a big
              session never dead-ends at Generate with an invisible quota wall. */}
          {entitled && groups.length > 0 && aiActionsRemaining != null && (
            <p
              className={cn(
                "text-xs",
                groups.length > aiActionsRemaining
                  ? "font-medium text-brand-red-text"
                  : "text-muted-foreground",
              )}
            >
              {groups.length > aiActionsRemaining
                ? `Needs ~${groups.length} AI actions but only ${aiActionsRemaining} remain — remove some groups or upgrade.`
                : `Uses ~${groups.length} of your ${aiActionsRemaining} remaining AI actions this month.`}
            </p>
          )}
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

      {/* US-1546: sticky batch summary — the state of play stays visible while
          scrolling a 600-photo session, with warning chips that jump to the
          offending group. */}
      {(staged.length > 0 || groups.length > 0) && (
        <div className="sticky top-16 z-20 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>
              <span className="font-semibold">{staged.length}</span> photo{staged.length === 1 ? "" : "s"}
            </span>
            <span>
              <span className="font-semibold">{listableCount}</span> listing{listableCount === 1 ? "" : "s"} to generate
            </span>
            <span className={cn(ungrouped.length > 0 && "text-amber-700 dark:text-amber-300")}>
              <span className="font-semibold">{ungrouped.length}</span> ungrouped
            </span>
            <span className="text-muted-foreground">
              ~{listableCount} AI action{listableCount === 1 ? "" : "s"}
              {aiActionsRemaining != null ? ` of ${aiActionsRemaining} left` : ""}
            </span>
          </div>
          {groupWarnings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {groupWarnings.slice(0, 8).map((w) => (
                <button
                  key={w.key}
                  type="button"
                  onClick={() => scrollToGroup(w.groupId)}
                  className="inline-flex max-w-72 items-center gap-1 truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
                  title={`${w.label} — click to jump to the group`}
                >
                  <Camera className="h-3 w-3 shrink-0" />
                  <span className="truncate">{w.label}</span>
                </button>
              ))}
              {groupWarnings.length > 8 && (
                <span className="self-center text-xs text-muted-foreground">
                  +{groupWarnings.length - 8} more in the Generate checkpoint
                </span>
              )}
            </div>
          )}
        </div>
      )}

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
              {(() => {
                // US-1541: honest aggregate — "X of N uploaded — Y failed".
                const done = uploadTasks.filter((t) => t.status === "done").length;
                const failed = uploadTasks.filter((t) => t.status === "error").length;
                const failedSuffix = failed > 0 ? ` — ${failed} failed` : "";
                if (uploading > 0) {
                  return `${done} of ${uploadTasks.length} uploaded${failedSuffix}…`;
                }
                return failed > 0
                  ? `${failed} photo${failed === 1 ? "" : "s"} failed`
                  : `All ${done} uploaded.`;
              })()}
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useAutolisterUploadStore.getState().clearTasks()}
                >
                  Dismiss all
                </Button>
              </div>
            )}
          </div>
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {/* US-1541: cap the per-file rows — 600 live progress bars is its
                own jank. Errors surface first (they need action); completed
                rows are summarized by the header, and overflow by the footer. */}
            {(() => {
              const errors = uploadTasks.filter((t) => t.status === "error");
              const inFlight = uploadTasks.filter(
                (t) => t.status !== "error" && t.status !== "done",
              );
              const visible = [...errors, ...inFlight].slice(0, UPLOAD_ROWS_CAP);
              const hidden = errors.length + inFlight.length - visible.length;
              return (
                <>
                  {visible.map((t) => (
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
                  {hidden > 0 && (
                    <p className="pt-1 text-center text-xs text-muted-foreground">
                      …plus {hidden} more in the queue.
                    </p>
                  )}
                </>
              );
            })()}
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

      {/* US-1543: one DnD context spans the ungrouped grid and the group
          cards, so photos drag between all of them (handle = grip icon;
          keyboard: focus the grip, Space lifts, arrows move, Space drops). */}
      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        onDragEnd={onGroupDragEnd}
      >
      {/* Ungrouped staging area */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Ungrouped photos {ungrouped.length > 0 && `(${ungrouped.length})`}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* US-1550: user-selectable grid order. */}
            <div className="flex items-center gap-1" title="Order the grid — grouping tools follow this order">
              <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
              <Select
                value={ungroupedSort}
                onValueChange={(v) => setUngroupedSort(v as UngroupedSortMode)}
              >
                <SelectTrigger size="sm" className="h-8 w-[140px]" aria-label="Sort photos by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(UNGROUPED_SORT_LABELS) as UngroupedSortMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {UNGROUPED_SORT_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {lastAutoGroupIds && lastAutoGroupIds.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => undoAutoGroup()}
                title="Dissolve the groups the last Auto-group run created — those photos return here"
              >
                <Undo2 className="mr-1 h-4 w-4" />
                Undo auto-group
              </Button>
            )}
            <Button
              size="sm"
              onClick={autoGroup}
              disabled={ungrouped.length === 0}
              title="Group photos into items automatically by capture time + visual similarity"
            >
              <Wand2 className="mr-1 h-4 w-4" />
              Auto-group ({ungrouped.length})
            </Button>
            {/* US-1550: fixed-size chunking in the displayed order — the rescue
                tool when photos carry no capture times for Auto-group to use. */}
            <div
              className="flex items-center gap-1"
              title="Cut the grid into items of exactly this many photos, in the order shown"
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={groupEveryN}
                disabled={ungrouped.length === 0}
              >
                <Layers className="mr-1 h-4 w-4" />
                Group every
              </Button>
              <Input
                type="number"
                min={1}
                max={24}
                value={Number.isFinite(groupEvery) ? groupEvery : ""}
                onChange={(e) => setGroupEvery(e.target.valueAsNumber)}
                aria-label="Photos per item"
                className="h-8 w-16"
              />
            </div>
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
        <UngroupedDropZone>
        {ungrouped.length === 0 ? (
          <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
            {staged.length === 0
              ? "No photos yet — upload some above."
              : "All photos are grouped. Generate when ready — or drag one here to ungroup it."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {ungroupedSorted.slice(0, ungroupedLimit).map((p) => {
              const bgInFlight = bgProcessing.has(p.id);
              const enhancingInFlight = enhancing.has(p.id);
              const processing = bgInFlight || enhancingInFlight;
              const cleaned = !!p.original;
              return (
                <PhotoDragTile
                  key={p.id}
                  photoId={p.id}
                  groupId={null}
                  className={cn(
                    "group relative aspect-square overflow-hidden rounded-md border-2",
                    selected.has(p.id)
                      ? "border-primary ring-2 ring-primary/40"
                      : "border-transparent hover:border-muted-foreground/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={(e) => toggleSelect(p.id, e.shiftKey)}
                    aria-label="Select photo (Shift-click selects the range)"
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
                  {/* US-1543: non-pointer fallback for adding to a group. */}
                  <MovePhotoMenu
                    photoId={p.id}
                    currentGroupId={null}
                    groups={groups}
                    onMove={(pid, target) => movePhotos([pid], target)}
                    onNewGroup={newGroupFromPhoto}
                    className="absolute left-7 top-1"
                  />
                  {processing && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    </div>
                  )}
                </PhotoDragTile>
              );
            })}
          </div>
        )}
        {ungroupedLimit < ungroupedSorted.length && (
          <LoadMoreSentinel
            label={`Showing ${ungroupedLimit} of ${ungroupedSorted.length} photos — scroll for more`}
            onMore={() => setUngroupedLimit((l) => l + GRID_CHUNK)}
          />
        )}
        </UngroupedDropZone>
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
              {/* US-1544/US-1903: on-demand AI grouping sanity check. Large
                  sessions are checked across sequential windows (1 AI action
                  each); progress shows below and the pass can be stopped. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void verifyGroups(false)}
                disabled={verifyingGroups || groups.length < 2}
                title="AI compares your groups: flags likely merges, splits, and misplaced photos — suggestions only, nothing is changed automatically. Large sessions are checked in batches (1 AI action each)."
              >
                {verifyingGroups ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" />
                )}
                Verify groups
              </Button>
              {verifyProgress && (
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  Checked {verifyProgress.done}/{verifyProgress.total} groups…
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      verifyCancelRef.current = true;
                    }}
                  >
                    Stop
                  </button>
                </span>
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
              <Button
                size="sm"
                variant="outline"
                onClick={ungroupAll}
                disabled={busy}
                title="Dissolve every group — all photos return to Ungrouped (nothing is deleted)"
              >
                <Ungroup className="mr-1 h-4 w-4" />
                Ungroup all
              </Button>
            </div>
          </div>
          {groups.slice(0, groupsLimit).map((g) => (
            <GroupDropZone key={g.id} groupId={g.id}>
            <Card className="p-3">
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
              {/* US-1544: AI grouping suggestions — dismissible, Apply is
                  undoable via the US-1543 toast Undo, never auto-applied. */}
              {suggestionsFor(g.id).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {suggestionsFor(g.id).map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200"
                      title={s.reason}
                    >
                      <Sparkles className="h-3 w-3 shrink-0" />
                      <span className="max-w-64 truncate">
                        {suggestionLabel(s, g.id)} · {Math.round(s.confidence * 100)}%
                      </span>
                      <button
                        type="button"
                        onClick={() => applySuggestion(s)}
                        className="font-semibold underline-offset-2 hover:underline"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        aria-label="Dismiss suggestion"
                        onClick={() => dismissSuggestion(s.id)}
                        className="rounded-full p-0.5 hover:bg-amber-500/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {g.photoIds.map((pid) => {
                  const p = stagedById.get(pid);
                  if (!p) return null;
                  const isCover = g.coverId === pid;
                  return (
                    <PhotoDragTile
                      key={pid}
                      photoId={pid}
                      groupId={g.id}
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
                      {/* US-1543: non-pointer fallback for moving between groups. */}
                      <MovePhotoMenu
                        photoId={pid}
                        currentGroupId={g.id}
                        groups={groups}
                        onMove={(photoId, target) => movePhotos([photoId], target)}
                        onNewGroup={newGroupFromPhoto}
                        className="absolute bottom-6 right-1"
                      />
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
                          {/* US-1551: the full photo-type vocabulary (same as
                              the photo manager / iOS), grouped for scanning.
                              "Front" is absent on purpose — the cover IS the
                              front; promote via the star. */}
                          {CORE_ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {PHOTO_TYPE_LABELS[r]}
                            </option>
                          ))}
                          <optgroup label="Measurements">
                            {MEASUREMENT_PHOTO_TYPES.map((r) => (
                              <option key={r} value={r}>
                                {PHOTO_TYPE_LABELS[r]}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="More shots">
                            {MORE_ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {PHOTO_TYPE_LABELS[r]}
                              </option>
                            ))}
                          </optgroup>
                          {/* US-1549: reference-only — not sent to eBay/AI. */}
                          <option value="internal">
                            {PHOTO_TYPE_LABELS.internal}
                          </option>
                        </select>
                      )}
                    </PhotoDragTile>
                  );
                })}
              </div>
            </Card>
            </GroupDropZone>
          ))}
          {groupsLimit < groups.length && (
            <LoadMoreSentinel
              label={`Showing ${groupsLimit} of ${groups.length} groups — scroll for more (use a photo's Move menu to reach unrendered groups)`}
              onMore={() => setGroupsLimit((l) => l + GROUPS_CHUNK)}
            />
          )}
        </div>
      )}
      </DndContext>

      {staged.length === 0 && groups.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
          Your grouped listings will appear here.
        </div>
      )}

      {/* US-1546: the pre-generate checkpoint — a final look at the batch
          before one AI action per listing is spent, with an explicit
          acknowledgment when photos would be left behind. */}
      <Dialog open={confirmGenerateOpen} onOpenChange={setConfirmGenerateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Generate {listableCount} listing{listableCount === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {staged.length} photo{staged.length === 1 ? "" : "s"} staged · ~
              {listableCount} AI action{listableCount === 1 ? "" : "s"}
              {aiActionsRemaining != null ? ` of your ${aiActionsRemaining} remaining` : ""}
              {aiActionsRemaining != null && listableCount > aiActionsRemaining
                ? " — this batch won't fit; trim it or upgrade."
                : ""}
            </DialogDescription>
          </DialogHeader>

          {groupWarnings.length > 0 && (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                {groupWarnings.length} thing{groupWarnings.length === 1 ? "" : "s"} worth a look first:
              </p>
              {groupWarnings.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  onClick={() => scrollToGroup(w.groupId)}
                  className="block w-full truncate text-left text-xs text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
                >
                  • {w.label}
                </button>
              ))}
            </div>
          )}

          {ungrouped.length > 0 && (
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
              <input
                type="checkbox"
                checked={ackUngrouped}
                onChange={(e) => setAckUngrouped(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
              />
              <span>
                <span className="font-medium">
                  {ungrouped.length} photo{ungrouped.length === 1 ? "" : "s"} will NOT be listed
                </span>{" "}
                — they're still ungrouped. Generate anyway; they stay staged here.
              </span>
            </label>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmGenerateOpen(false)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                setConfirmGenerateOpen(false);
                void generate();
              }}
              disabled={ungrouped.length > 0 && !ackUngrouped}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Generate {listableCount} listing{listableCount === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* US-1903: metered-action confirm for a multi-window verify pass. Shown
          before any AI action is spent so the count is never a surprise. */}
      <Dialog open={!!verifyConfirm} onOpenChange={(o) => !o && setVerifyConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Verify all {verifyConfirm?.totalGroups} groups?</DialogTitle>
            <DialogDescription>
              This session is too large for one AI check, so it runs in{" "}
              {verifyConfirm?.windowCount} batches — {verifyConfirm?.windowCount} AI action
              {verifyConfirm?.windowCount === 1 ? "" : "s"}
              {aiActionsRemaining != null ? ` of your ${aiActionsRemaining} remaining` : ""}. You
              can stop between batches; suggestions appear as you go.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerifyConfirm(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                aiActionsRemaining != null &&
                verifyConfirm != null &&
                verifyConfirm.windowCount > aiActionsRemaining
              }
              onClick={() => {
                const pending = verifyConfirm;
                setVerifyConfirm(null);
                if (pending) void runVerifyWindows(pending.windows, false);
              }}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Verify all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
