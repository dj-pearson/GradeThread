import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Sparkles,
  Star,
  X,
  ImageIcon,
  Tags,
  WandSparkles,
  Eraser,
  Undo2,
  Pencil,
  Camera,
  Ungroup,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { itemPhotoThumb } from "@/lib/images";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { processStagedImage } from "@/lib/image-worker-pool";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  useWindowVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  gridRowCount,
  gridRowItems,
  pinnedVirtualIndexes,
  squareTileRowHeight,
  ungroupedGridColumns,
} from "@/lib/autolister-virtual-grid";
import { useWindowVirtualAnchor } from "@/hooks/use-window-virtual-anchor";
import {
  movePhotosToGroup,
  reorderWithinGroup,
} from "@/lib/autolister-group-edits";
import {
  autoGroupPhotos,
  compareByProvenance,
  type GroupablePhoto,
  MAX_AUTO_GROUP_PHOTOS,
  sequenceRuns,
} from "@/lib/autolister-grouping";
import {
  computeTriage,
  type TriageCondition,
} from "@/lib/autolister-triage";
import {
  type ClientProposedGroup,
  mergeProposalWindows,
  planProposeWindows,
  PROPOSE_WINDOW,
} from "@/lib/autolister-propose-windows";
import {
  clearSession,
  idbAvailable,
  loadSession,
  migrateSessionFromLocalStorage,
  saveSession,
} from "@/lib/autolister-session-idb";
import {
  type GroupEditKind,
  groupingCorrectionScore,
  manualGroupsCreated,
  trackAiSuggestion,
  trackAutogroupRun,
  trackGroupEdit,
  trackGroupingOutcome,
} from "@/lib/autolister-telemetry";
import { tileLabel } from "@/lib/item-row-label";
import { stagedSortName } from "./autolister/staged-sort-name";
import { filesFromDataTransfer } from "./autolister/files-from-data-transfer";
import {
  type StagedPhoto,
  type StagedUploadResult,
  uploadStagingPhoto,
  useAutolisterUploadStore,
} from "@/stores/autolister-upload-store";
import { autoEnhance, type EnhanceStats } from "@/lib/image-enhance";
import { removeImageBackground, type BgMode } from "@/lib/background-removal";
import {
  fetchAutolisterHandoff,
  useAutolisterHandoffs,
  useClaimAutolisterHandoff,
  useDiscardAutolisterHandoff,
  useRunCoverQa,
  useStartAutolisterBatch,
} from "@/hooks/use-autolister";
import {
  dedupeSuggestions,
  MAX_VERIFY_SAMPLE_PHOTOS,
  planVerifyWindows,
} from "@/lib/autolister-verify-windows";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { explainGate } from "@/lib/plan-gates";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import {
  FLIPDESK_PHOTO_TYPES,
  isNonListablePhotoType,
  FLIPDESK_PLANS,
} from "@/lib/constants";
import {
  buildGroupWarnings,
  groupPhotoType,
  COVER_QA_REVIEW_THRESHOLD,
  type GroupWarning,
} from "@/pages/flipdesk/autolister/group-warnings";
import {
  GenerateConfirmDialog,
  ProposeConfirmDialog,
  VerifyConfirmDialog,
} from "./autolister/metered-confirm-dialogs";
import {
  UploadDropzone,
  UploadProgressPanel,
} from "./autolister/upload-panels";
import {
  AutoEnhanceBar,
  StudioBackgroundBar,
} from "./autolister/batch-photo-tools";
import {
  BatchSummaryBar,
  CoverQualityAdvisory,
  ParkedBatches,
} from "./autolister/session-status-panels";
import { BatchNav } from "./autolister/batch-nav";
import {
  GroupDropZone,
  GroupPhotoTag,
  MovePhotoMenu,
  PhotoDragTile,
  StagedThumb,
  UngroupedDropZone,
} from "./autolister/photo-drag-tiles";
import {
  GroupSelectionBar,
  GroupsToolbar,
  PhotoSelectionBar,
  UngroupedToolbar,
} from "./autolister/workbench-toolbars";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { FilterEmpty } from "@/components/flipdesk/filter-empty";

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
// a role the AI assigns (and the user can override). US-1551: the vocabulary is
// the canonical photo-type set, so a photo can be tagged here exactly like in
// the photo manager / iOS — the AI still only ASSIGNS the basic five
// (AI_ASSIGNABLE_ROLES); everything else is user-set and survives the AI pass.
// US-2461: what the seller PICKS from is now the profile-aware picker, not the
// raw type list, and the storage type carries an open-text qualifier beside it.
// US-1549: "internal" marks a seller-reference shot (the price tag you paid) —
// it generates with photo_type 'internal', which the edge excludes from eBay,
// AI passes, and public surfaces; it sorts last and is never sent to the
// classify/verify vision calls from here either.
type PhotoRole = (typeof FLIPDESK_PHOTO_TYPES)[number];
// Canonical gallery rank — FLIPDESK_PHOTO_TYPES order IS the sort order
// (front → back → tag → detail → measurements → defect → extras → universal
// → internal), the same rank photo-order.ts derives everywhere else.
const ROLE_ORDER: Record<PhotoRole, number> = Object.fromEntries(
  FLIPDESK_PHOTO_TYPES.map((t, i) => [t, i]),
) as Record<PhotoRole, number>;
// The roles the classify vision call is allowed to (re)assign. Any role
// OUTSIDE this set was necessarily hand-picked by the seller (measurement,
// interior, internal, …) — the AI never emits those, so an AI re-tag must not
// clobber them back to "detail".
const AI_ASSIGNABLE_ROLES: ReadonlySet<PhotoRole> = new Set([
  "front",
  "back",
  "tag",
  "detail",
  "defect",
]);
// US-2461: the three hand-rolled option lists that used to sit here (core /
// measurements / more) are gone. They were built by filtering
// FLIPDESK_PHOTO_TYPES, which means they offered `tag_2`, `detail_2..4` and the
// five fixed `measurement_*` types — the retired vocabulary — as NEW choices.
// PhotoTagSelect is the one picker now, and it reads the item's profile.

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
  // US-2461: photoId -> the `item_photos.photo_role` qualifier, held ALONGSIDE
  // the storage type rather than folded into it. That split is the whole point
  // of the epic: `roles` stays the small stable enum, and the qualifier
  // ("fabric", "size", "inseam") is open text that ships without a migration.
  // A photo whose type takes no qualifier simply has no entry.
  photoRoles?: Record<string, string>;
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

// US-1550: user-selectable ungrouped-grid ordering. "shooting" is the US-1540
// provenance sort the auto-grouper mirrors; the rest exist because EXIF-less
// exports make "shooting order" meaningless and the seller then needs a
// predictable order to group against (and to recover after an Ungroup).
type UngroupedSortMode = "shooting" | "name" | "date" | "upload";
const UNGROUPED_SORT_KEY = "flipdesk-autolister-ungrouped-sort";
const GROUP_EVERY_KEY = "flipdesk-autolister-group-every";

// Google Photos import pacing. The edge downloads, validates, EXIF-strips and
// re-uploads every picked photo, so the pull is chunked and spaced rather than
// asked for in one request that would outlive the proxy's patience. Mirrors
// MAX_IMPORT in services/edge-functions/src/routes/flipdesk-google-photos.ts —
// these two move together.
const GP_MAX_IMPORT = 200;
const GP_CHUNK_PAUSE_MS = 750;
// Outer safety net only. Picking hundreds of photos in Google's window is slow,
// so this has to be far longer than the pick itself; the real stop conditions
// are the server reporting the session gone, or Cancel.
const GP_PICK_MAX_MS = 45 * 60_000;
const UNGROUPED_SORT_LABELS: Record<UngroupedSortMode, string> = {
  shooting: "Shooting order",
  name: "File name",
  date: "Date taken",
  upload: "Upload order",
};
/** The same labels as the toolbar's <Select> wants them (US-2621). */
const UNGROUPED_SORT_OPTIONS = (
  Object.keys(UNGROUPED_SORT_LABELS) as UngroupedSortMode[]
).map((value) => ({ value, label: UNGROUPED_SORT_LABELS[value] }));

// US-1906: true virtualization for the two unbounded sections. US-1541 windowed
// them behind IntersectionObserver "load more" chunks, which fixed first paint
// but not the steady state: scroll far enough and every tile ever revealed
// stayed mounted, so a fully-expanded 600-photo session dragged. Both sections
// now render through @tanstack/react-virtual against the WINDOW scroller (the
// page scrolls, not an inner box — keeping it that way is what preserves
// dnd-kit's edge auto-scroll for free). Only the rows near the viewport mount,
// however far the seller has scrolled.
//
// Overscan is deliberately generous: these are image tiles behind `loading=lazy`,
// so a row that mounts a little early just starts its fetch a little early.
const GRID_OVERSCAN_ROWS = 4;
const GROUPS_OVERSCAN = 3;
// gap-2 on both grids (0.5rem). Feeds the row-height math — keep in lockstep.
const GRID_GAP_PX = 8;
// Fallback row height before the container has been measured (first paint) and
// the estimate for an unmeasured group card.
const GRID_ROW_ESTIMATE_PX = 120;
const GROUP_CARD_ESTIMATE_PX = 260;
// US-1907: the needs-attention chips in the triage strip, in display order.
const TRIAGE_CHIPS: { condition: TriageCondition; label: string }[] = [
  { condition: "singleton", label: "singletons" },
  { condition: "oversized", label: "oversized" },
  { condition: "missing_cover_or_tag", label: "missing cover/tag" },
  { condition: "has_suggestion", label: "AI suggestions" },
];

/**
 * US-1906: the virtualizer's window for this frame, plus the pinned drag source
 * if it has scrolled out of it.
 *
 * A pinned index is no longer in `getVirtualItems()`, so its position comes from
 * `measurementsCache` — the virtualizer's record of where it laid that index out.
 * It's rendered at that (off-screen) offset, which is the point: it keeps the
 * dragged node mounted for dnd-kit without dragging it back into view.
 */
function virtualItemsWithPin(
  virtualizer: Virtualizer<Window, Element>,
  pinned: number | null,
): VirtualItem[] {
  const items = virtualizer.getVirtualItems();
  if (pinned == null) return items;
  const byIndex = new Map(items.map((vi) => [vi.index, vi]));
  return pinnedVirtualIndexes(
    items.map((vi) => vi.index),
    pinned,
  ).flatMap((index) => {
    const item = byIndex.get(index) ?? virtualizer.measurementsCache[index];
    return item ? [item] : [];
  });
}


// US-957: covers scoring below this (0-100 listing-readiness) get a non-blocking
// "reshoot recommended" nudge before Generate. Advisory only — never blocks.


export function FlipdeskAutolisterPage() {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const ownerId = workspaceOwnerId ?? user?.id ?? null;
  const navigate = useNavigate();
  // US-2520: set when this session was opened from a running batch (the shared
  // batch nav carries it). A fresh Generate session has none.
  const [searchParams, setSearchParams] = useSearchParams();
  const liveBatchId = searchParams.get("batch");
  const qc = useQueryClient();
  const startBatch = useStartAutolisterBatch();
  const coverQa = useRunCoverQa();

  const { data: billing, isLoading: billingLoading } = useBillingSummary();
  const plan = billing?.subscription.plan ?? "free";
  const entitled = FLIPDESK_PLANS[plan].gateFlags.autolister;
  const autolisterGate = explainGate("autolister");

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
  // US-1543 single-level undo snapshot; US-1905 persists it into the IDB session.
  // Declared here (not by the mutation helpers) so the persist/rehydrate effects
  // below can read it.
  const undoGroupsRef = useRef<Group[] | null>(null);
  // US-1905: gate persistence until the async IndexedDB rehydrate finishes, so
  // the localStorage-seeded initial state can't clobber a fuller IDB session
  // (localStorage may be stale/truncated on large sessions).
  const hydratedRef = useRef(false);
  // Lazy-rehydrate staged/groups from localStorage so a refresh recovers the
  // in-flight session (instant first paint + the IndexedDB-unavailable
  // fallback); US-1905 then overrides from IndexedDB when it's available.
  // Uploaded photos live in Supabase Storage independently; only the in-memory
  // grouping state is at risk of loss.
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
  // US-1906: the id of the photo currently being dragged, so the virtualizers
  // can pin its row/group mounted for the whole drag (see pinnedVirtualIndexes).
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // US-1907: triage strip — filter the group list to a needs-attention
  // condition, and collapse every group's photos to a header-only overview.
  const [triageFilter, setTriageFilter] = useState<TriageCondition | null>(null);
  const [groupsCollapsed, setGroupsCollapsed] = useState(false);
  // US-1904: AI propose-groups ("AI group remaining"). Windows the ungrouped
  // photos sequentially; a >1-window pass confirms the metered count first,
  // shows progress, and is cancellable. Below-floor boundaries land in
  // `proposalReviews` as chips instead of being applied silently.
  const [proposing, setProposing] = useState(false);
  const [proposeProgress, setProposeProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const proposeCancelRef = useRef(false);
  const [proposeConfirm, setProposeConfirm] = useState<
    | { windows: string[][]; windowCount: number; photoCount: number }
    | null
  >(null);
  const [proposalReviews, setProposalReviews] = useState<
    { id: string; photoIds: string[]; confidence: number; reason: string }[]
  >([]);
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
  // US-2374: batches waiting from the phone, and which one is being pulled in.
  const { data: handoffs = [] } = useAutolisterHandoffs();
  const claimHandoff = useClaimAutolisterHandoff();
  const discardHandoff = useDiscardAutolisterHandoff();
  const [loadingHandoffId, setLoadingHandoffId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Google Photos import: whether the server has it configured, and an
  // in-flight flag while the user picks photos in the Google popup.
  const [gpConfigured, setGpConfigured] = useState(false);
  const [gpImporting, setGpImporting] = useState(false);
  // Chunked-download progress, once picking is done. `total` is 0 until the
  // first chunk comes back and tells us how many were picked.
  const [gpProgress, setGpProgress] = useState<{ done: number; total: number } | null>(null);
  // Lets the button double as "Cancel" while a pick is in flight — we can no
  // longer infer cancellation from the popup (see `importFromGooglePhotos`).
  const gpCancelRef = useRef<(() => void) | null>(null);
  const gpTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Set by Cancel/unmount so a chunk loop already in flight stops at the next
  // chunk boundary instead of running to completion in the background.
  const gpAbortRef = useRef(false);
  // The poll now runs to its own timeout rather than stopping when the picker
  // window closes, so it must be torn down explicitly on unmount.
  useEffect(
    () => () => {
      gpAbortRef.current = true;
      clearInterval(gpTimerRef.current);
    },
    [],
  );

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
  /** US-2621: which groups the pending Generate covers. null = all of them. */
  const [generateTarget, setGenerateTarget] = useState<string[] | null>(null);
  const [ackUngrouped, setAckUngrouped] = useState(false);
  // US-535: studio background. Mode for the one-tap clean, photos currently
  // being segmented, a batch-busy flag, and one-time model-download progress.
  const [bgMode, setBgMode] = useState<BgMode>("white");
  // US-2520: photos nothing has been applied to yet — an `original` means the
  // batch tools already ran on that one, and both bars count the same thing.
  const untouchedStagedCount = staged.filter((p) => !p.original).length;
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

  // US-1905: rehydrate the FULL session from IndexedDB on mount (migrating an
  // existing localStorage session on first run). IDB is authoritative — for a
  // 600-photo session localStorage may be stale or truncated. `hydratedRef`
  // gates the persist effect until this completes, so the localStorage-seeded
  // initial state can't overwrite a fuller IDB session. Undo snapshot restored
  // too. No IndexedDB (some private-browsing modes) → keep the localStorage
  // state and mark hydrated immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (idbAvailable()) {
        try {
          const raw = (() => {
            try {
              return window.localStorage.getItem(storageKey);
            } catch {
              return null;
            }
          })();
          const loaded =
            (await migrateSessionFromLocalStorage(sessionId.current, raw)) ??
            (await loadSession(sessionId.current));
          if (!cancelled && loaded) {
            if (Array.isArray(loaded.staged)) {
              const idbStaged = loaded.staged as StagedPhoto[];
              const idbIds = new Set(idbStaged.map((p) => p.id));
              // Merge, not replace: keep any photo an upload claimed during the
              // async rehydrate window (IDB is authoritative for the rest).
              setStaged((cur) => [...idbStaged, ...cur.filter((p) => !idbIds.has(p.id))]);
            }
            if (Array.isArray(loaded.groups) && loaded.groups.length > 0) {
              setGroups(loaded.groups as Group[]);
            }
            if (Array.isArray(loaded.undo)) undoGroupsRef.current = loaded.undo as Group[];
          }
        } catch {
          /* keep the localStorage-seeded state */
        }
      }
      if (!cancelled) hydratedRef.current = true;
      // US-1905: resume uploads persisted before a reload (part 2). Runs after
      // the localStorage-derived staged identities are synced, so a photo that
      // finished before the reload isn't re-uploaded.
      void useAutolisterUploadStore.getState().resumeUploads(sessionId.current);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist whenever staged / groups change. US-1905: IndexedDB is the primary
  // store (no size limit → a 600-photo session saves fully, undo snapshot
  // included). localStorage remains the fallback when IndexedDB is unavailable,
  // where the US-1541 size-guard (drop `original` snapshots, warn once) still
  // applies. Gated on `hydratedRef` so it can't run before the IDB rehydrate.
  const persistWarnedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !hydratedRef.current) return;
    if (idbAvailable()) {
      void saveSession(sessionId.current, {
        staged,
        groups,
        undo: undoGroupsRef.current,
        sort: { ungroupedSort, groupEvery },
        updatedAt: Date.now(),
      });
      return;
    }
    // Fallback: localStorage, size-guarded (only reached without IndexedDB).
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ staged, groups }));
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
      window.localStorage.setItem(storageKey, JSON.stringify({ staged: slimmed, groups }));
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
  }, [staged, groups, storageKey, ungroupedSort, groupEvery]);

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

  // US-1907: needs-attention buckets + session totals for the triage strip.
  const triageSummary = useMemo(
    () =>
      computeTriage(
        groups.map((g) => ({
          id: g.id,
          photoIds: g.photoIds,
          coverId: g.coverId,
          roles: g.roles ?? {},
        })),
        groupSuggestions,
        ungrouped.length,
        MAX_AUTO_GROUP_PHOTOS,
      ),
    [groups, groupSuggestions, ungrouped.length],
  );
  // The set of group ids matching the active triage filter (for list filtering).
  const triageFilterSet = useMemo(
    () => (triageFilter ? new Set(triageSummary.buckets[triageFilter]) : null),
    [triageFilter, triageSummary],
  );
  // The groups actually rendered: all of them, or just the filtered condition.
  const shownGroups = useMemo(
    () => (triageFilterSet ? groups.filter((g) => triageFilterSet.has(g.id)) : groups),
    [groups, triageFilterSet],
  );
  // Clear a stale filter once the seller resolves the last group in that bucket.
  useEffect(() => {
    if (triageFilter && triageSummary.buckets[triageFilter].length === 0) {
      setTriageFilter(null);
    }
  }, [triageFilter, triageSummary]);

  // ── US-1906: virtualization of the two unbounded sections ───────────
  // Both virtualize against the WINDOW, so the page keeps one scrollbar and
  // dnd-kit's viewport-edge auto-scroll keeps working untouched. Each needs its
  // list's distance from the top of the document (`scrollMargin`); the grid also
  // needs its width, because a square tile's height IS its width.
  const gridRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  const gridAnchor = useWindowVirtualAnchor(gridRef);
  const groupsAnchor = useWindowVirtualAnchor(groupsRef);

  // Columns follow the grid's VIEWPORT breakpoints; the tile size follows the
  // container's own width. Feeding the container width to the breakpoints would
  // under-count columns whenever the sidebar makes the grid narrower than the
  // window (a 7-column CSS layout rendered 3 tiles to a row).
  const gridColumns = ungroupedGridColumns(gridAnchor.viewportWidth);
  const gridRowHeight =
    squareTileRowHeight(gridAnchor.width, gridColumns, GRID_GAP_PX) || GRID_ROW_ESTIMATE_PX;

  const gridVirtualizer = useWindowVirtualizer({
    count: gridRowCount(ungroupedSorted.length, gridColumns),
    estimateSize: () => gridRowHeight,
    overscan: GRID_OVERSCAN_ROWS,
    scrollMargin: gridAnchor.offsetTop,
    // Tiles are a fixed square, so the estimate is exact — skip re-measurement
    // and its ResizeObserver-per-row cost.
    getItemKey: (index) => `row-${index}`,
  });
  const groupsVirtualizer = useWindowVirtualizer({
    count: shownGroups.length,
    // Group cards vary (name/SKU wrap, suggestion chips, collapsed vs. expanded
    // photo grid), so these ARE measured — measureElement's ResizeObserver also
    // catches a card growing in place (e.g. collapse toggled) without a remount.
    estimateSize: () => GROUP_CARD_ESTIMATE_PX,
    overscan: GROUPS_OVERSCAN,
    scrollMargin: groupsAnchor.offsetTop,
    getItemKey: (index) => shownGroups[index]?.id ?? index,
  });

  // Which row / group the live drag started from — pinned mounted so scrolling
  // the source away mid-drag can't cancel the drag.
  const dragSourceRow = useMemo(() => {
    if (!activeDragId) return null;
    const idx = ungroupedSorted.findIndex((p) => p.id === activeDragId);
    return idx < 0 ? null : Math.floor(idx / gridColumns);
  }, [activeDragId, ungroupedSorted, gridColumns]);
  const dragSourceGroup = useMemo(() => {
    if (!activeDragId) return null;
    const idx = shownGroups.findIndex((g) => g.photoIds.includes(activeDragId));
    return idx < 0 ? null : idx;
  }, [activeDragId, shownGroups]);

  const gridRows = virtualItemsWithPin(gridVirtualizer, dragSourceRow);
  const groupRows = virtualItemsWithPin(groupsVirtualizer, dragSourceGroup);

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
    gpAbortRef.current = false;
    let popup: Window | null = null;
    const stop = () => {
      clearInterval(gpTimerRef.current);
      gpTimerRef.current = undefined;
      gpCancelRef.current = null;
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
        picker_uri?: string;
        error?: string;
      };
      // Fast path returns picker_uri (already signed in — straight to the
      // picker, no consent screen); first-time returns consent_url.
      const openUrl = start.picker_uri || start.consent_url;
      if (!startRes.ok || !start.session_id || !openUrl) {
        toast.error(start.error || "Could not start Google Photos import.");
        setGpImporting(false);
        return;
      }
      const sessionId = start.session_id;
      popup = window.open(openUrl, "gphotos", "width=620,height=760");
      if (!popup) {
        toast.error("Please allow popups to import from Google Photos.");
        setGpImporting(false);
        return;
      }
      toast.info(
        "Pick your photos in the Google window and hit Done — the window closes on its own and they'll appear here.",
        { duration: 8000 },
      );

      const startedAt = Date.now();
      // The import runs in CHUNKS (the edge caps a single request's slice), and
      // each chunk's photos land in the grid as soon as they arrive so a
      // 200-photo pull shows steady progress instead of one long freeze. The
      // pause between chunks paces the edge — same reason the iOS uploader
      // meters itself — so a big import can't swamp the container.
      const doImport = async () => {
        let offset = 0;
        let total = 0;
        let importedCount = 0;
        let errorCount = 0;
        for (;;) {
          if (gpAbortRef.current) return;
          const imp = await edgeFetch(
            `/api/flipdesk/google/photos/import?session=${sessionId}&offset=${offset}`,
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
            total?: number;
            nextOffset?: number;
            errors?: number;
            done?: boolean;
            error?: string;
          };
          if (!imp.ok) {
            throw new Error(ij.error || `import failed (${imp.status})`);
          }
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
          if (added.length > 0) setStaged((prev) => [...prev, ...added]);
          importedCount += added.length;
          errorCount += ij.errors ?? 0;
          total = ij.total ?? total;
          setGpProgress({ done: importedCount, total });

          // The server is the authority on where the cursor goes; only fall
          // back to our own arithmetic if it didn't say.
          const next = ij.nextOffset ?? offset + added.length;
          if (ij.done || next <= offset || (total > 0 && next >= total)) break;
          offset = next;
          await new Promise((r) => setTimeout(r, GP_CHUNK_PAUSE_MS));
        }

        setGpProgress(null);
        if (importedCount > 0) {
          toast.success(
            `Imported ${importedCount} photo${importedCount === 1 ? "" : "s"} from Google Photos.` +
              (errorCount > 0 ? ` ${errorCount} couldn't be read and were skipped.` : ""),
          );
          if (total >= GP_MAX_IMPORT) {
            toast.info(
              `Google Photos imports are capped at ${GP_MAX_IMPORT} photos at a time — run it again for the rest.`,
            );
          }
        } else {
          toast.warning("No photos were imported.");
        }
      };

      // The picker window is NOT a cancellation signal: Google's picker tells
      // the user to close that window and finish "in the other window", so
      // closing it is the NORMAL completion path, and `mediaItemsSet` often
      // flips a beat later — stopping on close would race the very poll that
      // returns ready. So we poll until the session is ready (then WE close the
      // window, below) or we time out; the button offers an explicit cancel
      // instead. (The COOP header is `same-origin-allow-popups`, so the handle
      // survives and `popup.close()` actually works — see public/_headers.)
      gpCancelRef.current = () => {
        gpAbortRef.current = true;
        stop();
        setGpProgress(null);
        toast.info("Google Photos import cancelled.");
      };

      // No short wall-clock deadline here. The old 4-minute cap was measured
      // from the moment the popup OPENED, so the time the seller spent picking
      // burned the whole budget — a 200-photo pick timed out before they ever
      // hit Done, and the toast fired behind the Google window, which is why it
      // read as "nothing happened". The real terminal signals are the server
      // saying the session is gone (404/410) or the seller hitting Cancel.
      gpTimerRef.current = setInterval(() => {
        void (async () => {
          const expired = Date.now() - startedAt > GP_PICK_MAX_MS;
          let ready = false;
          try {
            const pr = await edgeFetch(
              `/api/flipdesk/google/photos/poll?session=${sessionId}`,
            );
            if (pr.status === 404 || pr.status === 410) {
              stop();
              toast.info(
                "The Google Photos session expired — start the import again.",
              );
              return;
            }
            ready = !!((await pr.json()) as { ready?: boolean }).ready;
          } catch {
            /* transient — keep polling */
          }
          if (ready) {
            // Picking is over; stop polling but stay "busy" — the chunked
            // download is the part the seller now watches, and Cancel has to
            // keep working through it.
            clearInterval(gpTimerRef.current);
            gpTimerRef.current = undefined;
            try {
              popup?.close();
            } catch {
              /* handle lost for some reason — the user can close it themselves */
            }
            gpCancelRef.current = () => {
              gpAbortRef.current = true;
              stop();
              setGpProgress(null);
              toast.info("Stopped — the photos already brought over are below.");
            };
            setGpProgress({ done: 0, total: 0 });
            try {
              await doImport();
            } catch (err) {
              setGpProgress(null);
              toastError(err, "Google Photos import failed.");
            } finally {
              stop();
            }
            return;
          }
          if (expired) {
            stop();
            toast.info(
              "Google Photos import timed out — if you finished picking, try again.",
            );
          }
        })();
      }, 2500);
    } catch (err) {
      toastError(err, "Could not start Google Photos.");
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
            photoRoles: g.photoRoles
              ? Object.fromEntries(
                  Object.entries(g.photoRoles).filter(([pid]) => !idSet.has(pid)),
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
      toastError(err, "Background removal failed.");
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
      toastError(err, "Auto-enhance failed.");
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
      toastError(err, "Could not save edit.");
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
  // (undoGroupsRef is declared near the session state above so US-1905's
  // persist/rehydrate effects can read the snapshot.)

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
            toastError(err, "Verify failed.");
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

  // ── US-1904: AI propose-groups ("AI group remaining") ──────────────
  // Below this confidence, a proposed boundary is surfaced as a review chip
  // rather than applied — the seller confirms it.
  const PROPOSE_APPLY_FLOOR = 0.6;

  /** Create groups from proposed photo-id runs in ONE undoable mutation, only
   *  for photos that are still ungrouped when applied. */
  function applyProposedGroups(runs: { photoIds: string[] }[]) {
    applyGroupEdit(
      `AI grouped ${runs.length} item${runs.length === 1 ? "" : "s"}.`,
      (prev) => {
        const grouped = new Set(prev.flatMap((g) => g.photoIds));
        const created: Group[] = [];
        for (const run of runs) {
          const ids = run.photoIds.filter((id) => !grouped.has(id));
          if (ids.length === 0) continue;
          for (const id of ids) grouped.add(id);
          created.push({
            id: crypto.randomUUID(),
            name: `Item ${prev.length + created.length + 1}`,
            photoIds: ids,
            coverId: ids[0]!,
          });
        }
        return created.length === 0 ? prev : [...prev, ...created];
      },
      "split",
    );
  }

  async function runProposeWindows(windows: string[][]) {
    if (windows.length === 0) return;
    const multi = windows.length > 1;
    const totalPhotos = ungroupedSorted.length;
    setProposing(true);
    proposeCancelRef.current = false;
    setProposeProgress(multi ? { done: 0, total: totalPhotos } : null);
    const pathById = new Map(ungroupedSorted.map((p) => [p.id, p.storagePath]));
    const windowResults: ClientProposedGroup[][] = [];
    let anyError = false;
    let done = 0;
    try {
      for (const win of windows) {
        if (proposeCancelRef.current) break;
        const photos = win
          .map((id) => ({ id, storage_path: pathById.get(id) ?? "" }))
          .filter((p) => p.storage_path);
        try {
          const res = await edgeFetch("/api/flipdesk/autolister/propose-groups", {
            method: "POST",
            json: { photos },
          });
          const json = (await res.json().catch(() => ({}))) as {
            groups?: { photo_ids: string[]; confidence: number; reason: string }[];
            error?: string;
          };
          if (!res.ok) {
            anyError = true;
            if (!multi) toast.error(json.error || "Could not propose groups.");
          } else {
            windowResults.push(
              (json.groups ?? []).map((g) => ({
                photoIds: g.photo_ids,
                confidence: g.confidence,
                reason: g.reason,
              })),
            );
          }
        } catch (err) {
          anyError = true;
          if (!multi) {
            toastError(err, "Propose failed.");
          }
        }
        done += win.length;
        if (multi) setProposeProgress({ done, total: totalPhotos });
      }

      if (proposeCancelRef.current) {
        toast.info(`Stopped — proposed over ${done} of ${totalPhotos} photos.`);
        return;
      }
      // A singleton stays a singleton; only multi-photo items are worth applying.
      const proposals = mergeProposalWindows(windowResults).filter((g) => g.photoIds.length >= 2);
      if (proposals.length === 0) {
        if (anyError) toast.error("Some windows couldn't be proposed — try again.");
        else toast.info("AI didn't find clear item boundaries — group these manually.");
        return;
      }
      const confident = proposals.filter((g) => g.confidence >= PROPOSE_APPLY_FLOOR);
      const uncertain = proposals.filter((g) => g.confidence < PROPOSE_APPLY_FLOOR);
      if (confident.length > 0) applyProposedGroups(confident);
      if (uncertain.length > 0) {
        setProposalReviews((prev) => [
          ...prev,
          ...uncertain.map((g) => ({
            id: crypto.randomUUID(),
            photoIds: g.photoIds,
            confidence: g.confidence,
            reason: g.reason,
          })),
        ]);
      }
      toast.success(
        `AI proposed ${confident.length} item${confident.length === 1 ? "" : "s"}` +
          (uncertain.length > 0 ? ` — ${uncertain.length} more to review below.` : "."),
      );
    } finally {
      setProposing(false);
      setProposeProgress(null);
    }
  }

  /** 'AI group remaining' — window the ungrouped photos and propose item
   *  boundaries. A >1-window pass confirms the metered count first. */
  function proposeGroups() {
    if (proposing) return;
    const ids = ungroupedSorted.map((p) => p.id);
    if (ids.length < 2) {
      toast.info("Add at least two ungrouped photos first.");
      return;
    }
    const windows = planProposeWindows(ids, PROPOSE_WINDOW);
    if (windows.length === 0) return;
    if (windows.length > 1) {
      setProposeConfirm({ windows, windowCount: windows.length, photoCount: ids.length });
      return;
    }
    void runProposeWindows(windows);
  }

  function acceptProposalReview(id: string) {
    const review = proposalReviews.find((r) => r.id === id);
    if (review) applyProposedGroups([{ photoIds: review.photoIds }]);
    setProposalReviews((prev) => prev.filter((r) => r.id !== id));
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

  /** US-2621: the structural slice the selection bar's menu needs. */
  const toolbarGroups = useMemo(
    () => groups.map((g) => ({ id: g.id, name: g.name, photoCount: g.photoIds.length })),
    [groups],
  );

  /** US-1546 AC2: suspicious groups, each linkable/scrollable. */
  const groupWarnings = useMemo<GroupWarning[]>(
    () => buildGroupWarnings(groups, coverScores, groupSuggestions),
    [groups, coverScores, groupSuggestions],
  );

  /** Scroll to a group card, mounting it first when it's outside the window. */
  function scrollToGroup(groupId: string) {
    // US-1907: a jump target must render — clear any triage filter that would
    // exclude it. With the filter cleared, shownGroups IS groups, so the group's
    // index in the full list is the virtualizer's index.
    setTriageFilter(null);
    setConfirmGenerateOpen(false);
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx < 0) return;
    // US-1906: a virtualized target may not be mounted, so scrollIntoView has
    // nothing to find — the virtualizer scrolls by index instead and mounts it
    // on arrival. Let the filter clear commit first (it changes the count).
    setTimeout(() => {
      groupsVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    }, 60);
  }

  /** Generate button → checkpoint dialog (the button's own disabled state
   * already enforces the busy / no-groups / uploads-in-flight / entitlement
   * gates, so opening never bypasses them). US-2621: `only` scopes the run —
   * and the dialog with it — to those groups. */
  function openGenerateConfirm(only?: string[]) {
    setGenerateTarget(only && only.length > 0 ? only : null);
    setAckUngrouped(false);
    setConfirmGenerateOpen(true);
  }

  /**
   * US-2621: what the checkpoint dialog is about to spend, scoped to whatever
   * this Generate covers. The metered-spend rule (never spend an AI action
   * without first saying how many) is only kept if the count and the warnings
   * describe the SAME groups the button will send.
   */
  const generateScope = useMemo(() => {
    const wanted = generateTarget ? new Set(generateTarget) : null;
    const list = wanted ? groups.filter((g) => wanted.has(g.id)) : groups;
    const ids = new Set(list.map((g) => g.id));
    return {
      partial: wanted != null && list.length < groups.length,
      listableCount: list.filter((g) => g.photoIds.length > 0).length,
      photoCount: list.reduce((n, g) => n + g.photoIds.length, 0),
      warnings: groupWarnings.filter((w) => ids.has(w.groupId)),
      remainingGroups: groups.length - list.length,
    };
  }, [generateTarget, groups, groupWarnings]);

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

  /** US-1906: remember the drag source so its row/group stays mounted. */
  function onGroupDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function onGroupDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
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
        // `front` takes no qualifier, so promoting a photo drops whatever role
        // it carried — leaving one behind would write (front, "fabric").
        const photoRoles = { ...(g.photoRoles ?? {}) };
        delete photoRoles[photoId];
        if (g.coverId && g.coverId !== photoId) delete photoRoles[g.coverId];
        return { ...g, coverId: photoId, roles, photoRoles };
      }),
    );
  }

  // US-533: override a non-cover photo's tag. (The cover's is fixed to "front"
  // — change the front by picking a new cover.) US-2461: the picker now returns
  // a (type, role) pair, so both maps move together.
  function setPhotoTag(
    groupId: string,
    photoId: string,
    type: PhotoRole,
    role: string | null,
  ) {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const photoRoles = { ...(g.photoRoles ?? {}) };
        if (role) photoRoles[photoId] = role;
        else delete photoRoles[photoId];
        return {
          ...g,
          roles: { ...(g.roles ?? {}), [photoId]: type },
          photoRoles,
        };
      }),
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
      // outside that set (internal, measurements, interior, …) was hand-picked
      // by the seller — re-apply those over the AI result instead of letting the
      // pass demote them to "detail".
      // US-2461: a QUALIFIED photo counts as hand-picked too. The AI emits bare
      // types, so "Fabric close-up" comes back as `detail` and would otherwise
      // survive as a type while its role was silently dropped below.
      const preservedManual = Object.fromEntries(
        Object.entries(g.roles ?? {}).filter(
          ([pid, role]) =>
            !AI_ASSIGNABLE_ROLES.has(role) || !!g.photoRoles?.[pid],
        ),
      ) as Record<string, PhotoRole>;
      const roles = { ...(json.roles ?? {}), ...preservedManual };
      // Drop a qualifier the AI just retyped away from under (the seller's
      // "Size tag" reclassified as a defect keeps no `size` role).
      const photoRoles = Object.fromEntries(
        Object.entries(g.photoRoles ?? {}).filter(
          ([pid]) => pid in preservedManual && roles[pid] !== "front",
        ),
      );
      updateGroup(groupId, { coverId: cover, roles, photoRoles });
      return true;
    } catch (err) {
      toastError(err, "Auto-tag failed.");
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

  /**
   * US-2621: dissolve ONE group. Nothing is deleted — the photos land back in
   * Ungrouped, where they can be re-grouped. This used to be labelled "Delete"
   * with a red trash icon, which read as "destroys my photos", so sellers with
   * a bad group had no action they were willing to click.
   */
  function ungroupGroup(groupId: string) {
    const count = groups.find((g) => g.id === groupId)?.photoIds.length ?? 0;
    applyGroupEdit(
      `Group dissolved — ${count} photo${count === 1 ? "" : "s"} back in Ungrouped.`,
      (prev) => prev.filter((g) => g.id !== groupId),
      "move",
    );
  }

  /** US-2621: the same dissolve over a checkbox selection. */
  function ungroupSelectedGroups() {
    const ids = new Set(selectedGroups);
    if (ids.size === 0) return;
    const count = groups
      .filter((g) => ids.has(g.id))
      .reduce((n, g) => n + g.photoIds.length, 0);
    applyGroupEdit(
      `${ids.size} group${ids.size === 1 ? "" : "s"} dissolved — ${count} photo${count === 1 ? "" : "s"} back in Ungrouped.`,
      (prev) => prev.filter((g) => !ids.has(g.id)),
      "move",
    );
    setSelectedGroups(new Set());
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
    // US-1905: drop the IndexedDB session + its resume blobs too.
    void clearSession(sessionId.current);
    try {
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem("autolister:sessionId");
    } catch {
      /* best-effort */
    }
  }

  /**
   * Generate listings. With no argument that means the whole session, which is
   * what the page-header button does. US-2621: pass group ids to send only
   * those — the per-item "Generate" and the selection bar's "Generate N". A
   * partial run leaves everything it didn't take exactly where it was and
   * keeps the seller on this page, so finishing one item early no longer means
   * either sending the whole batch or waiting for it.
   */
  async function generate(only?: string[] | null) {
    if (!ownerId) return;
    if (groups.length === 0) {
      toast.error("Create at least one group first.");
      return;
    }
    const targetIds = only && only.length > 0 ? new Set(only) : null;
    const targets = targetIds ? groups.filter((g) => targetIds.has(g.id)) : groups;
    if (targets.length === 0) {
      toast.error("Those items are no longer in this session.");
      return;
    }
    const partial = targets.length < groups.length;
    // US-1908: session-end grouping outcome — how much the seller corrected the
    // auto-grouper — captured BEFORE generation mutates anything. A partial run
    // is not the end of the session, and scoring the corrections against a
    // fraction of the groups would report a number that means nothing.
    if (!partial) {
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
    }
    setBusy(true);
    try {
      const itemIds: string[] = [];
      for (const g of targets) {
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
        // US-2769: retyping the cover has to reach what ships, not just the UI.
        const roleOf = (p: StagedPhoto): PhotoRole => groupPhotoType(g, p.id);
        // US-2461: the qualifier rides alongside the type. The cover is a
        // `front`, which takes none.
        // Same for the qualifier: a cover retyped "brand label" keeps it.
        const qualifierOf = (p: StagedPhoto): string | null =>
          g.photoRoles?.[p.id] ?? null;
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
          photo_role: qualifierOf(p),
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
      if (partial) {
        // The generated groups and their photos now belong to real items, so
        // they leave the staging session; everything else is untouched and the
        // seller stays on this page to keep working. The batch id goes into the
        // URL so BatchNav appears and the run is one click away.
        const takenPhotoIds = new Set(targets.flatMap((g) => g.photoIds));
        const remainingGroups = groups.filter((g) => !targets.includes(g));
        const remainingStaged = staged.filter((p) => !takenPhotoIds.has(p.id));
        // The undo snapshot describes groups that no longer exist here.
        undoGroupsRef.current = null;
        setGroups(remainingGroups);
        setStaged(remainingStaged);
        setSelectedGroups(new Set());
        setSelected(new Set());
        // Persist NOW rather than leaving it to the save effect: the URL change
        // below re-renders, and a session that exists only in React state is one
        // reload away from gone.
        if (idbAvailable()) {
          void saveSession(sessionId.current, {
            staged: remainingStaged,
            groups: remainingGroups,
            undo: null,
            sort: { ungroupedSort, groupEvery },
            updatedAt: Date.now(),
          });
        }
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("batch", res.batch_id);
            return next;
          },
          { replace: true },
        );
        toast.success(
          `Generating ${itemIds.length} listing${itemIds.length === 1 ? "" : "s"} — the rest of your session is still here.`,
          {
            action: {
              label: "Open queue",
              onClick: () =>
                navigate(`/dashboard/flipdesk/autolister/queue?batch=${res.batch_id}`),
            },
          },
        );
        return;
      }
      // Clear the persisted session — the batch is now durable on the server,
      // and re-showing the staged photos on the next visit would be confusing.
      clearStoredSession();
      navigate(`/dashboard/flipdesk/autolister/queue?batch=${res.batch_id}`);
    } catch (err) {
      toastError(err, "Could not start generation.");
    } finally {
      setBusy(false);
    }
  }

  // US-2374: pull a batch the phone parked server-side into THIS session.
  // Appended, never replacing: the seller may already have photos on screen,
  // and a handoff arriving mid-session must not wipe them.
  async function loadHandoff(id: string) {
    setLoadingHandoffId(id);
    try {
      const session = await fetchAutolisterHandoff(id);
      const known = new Set(staged.map((p) => p.storagePath));
      const incoming = session.photos.filter((p) => !known.has(p.storage_path));
      if (incoming.length === 0) {
        toast.info("Those photos are already in this session.");
        await claimHandoff.mutateAsync(id).catch(() => {});
        return;
      }
      const arrived: StagedPhoto[] = incoming.map((p) => ({
        id: p.id,
        url: p.url,
        storagePath: p.storage_path,
        thumbnailUrl: p.thumbnail_url,
        thumbnailStoragePath: p.thumbnail_storage_path,
        width: p.width,
        height: p.height,
        bytes: p.bytes ?? 0,
        capturedAtMs: p.captured_at_ms,
        phash: p.phash ?? "",
        sourceName: p.source_name ?? undefined,
      }));
      const arrivedIds = new Set(arrived.map((p) => p.id));
      setStaged((prev) => [...prev, ...arrived]);
      // Only groups whose photos actually arrived — a photo already staged here
      // keeps whatever group this session put it in.
      setGroups((prev) => {
        const created = session.groups
          .map((g) => g.photo_ids.filter((pid) => arrivedIds.has(pid)))
          .filter((ids) => ids.length > 0)
          .map((ids, i) => ({
            id: crypto.randomUUID(),
            name: `Item ${prev.length + i + 1}`,
            photoIds: ids,
            coverId: ids[0]!,
          }));
        return [...prev, ...created];
      });
      await claimHandoff.mutateAsync(id).catch(() => {});
      toast.success(
        `Loaded ${arrived.length} photo${arrived.length === 1 ? "" : "s"} from your phone.`,
      );
    } catch (err) {
      toastError(err, "Could not load that batch.");
    } finally {
      setLoadingHandoffId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* US-2520: shown only when this session was reached from a running
          batch, so stepping back to stage more photos does not strand it. */}
      <BatchNav batchId={liveBatchId} current="generate" />
      <PageHeader
        icon={Sparkles}
        title="Generate"
        subtitle="Upload a batch of photos, group them into items, and generate complete eBay listings in seconds."
        actions={
          <div className="flex flex-col items-end gap-2">
          <Button
            // US-2621: wrapped, not passed by reference — openGenerateConfirm's
            // first parameter is the group subset, and a bare handler would hand
            // it the click event as one.
            onClick={() => openGenerateConfirm()}
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
          {/* US-2872: the button was disabled with no reason given, which is
              the hidden-feature problem wearing a grey coat. Say what it does
              and which plan has it, right where the seller is standing. */}
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
        }
      />

      {/* US-2520: the three session-status panels live in
          ./autolister/session-status-panels.tsx — what is waiting from the
          phone (US-2374), what the batch adds up to (US-1546), and what is
          worth fixing before spending AI on it (US-957). */}
      <ParkedBatches
        handoffs={handoffs}
        loadingHandoffId={loadingHandoffId}
        onLoad={loadHandoff}
        onDiscard={(id) => discardHandoff.mutate(id)}
      />

      {(staged.length > 0 || groups.length > 0) && (
        <BatchSummaryBar
          stagedCount={staged.length}
          listableCount={listableCount}
          ungroupedCount={ungrouped.length}
          aiActionsRemaining={aiActionsRemaining}
          groupWarnings={groupWarnings}
          onWarningClick={scrollToGroup}
        />
      )}

      {entitled && <CoverQualityAdvisory lowCoverCount={lowCoverCount} />}

      {/* Premium gate (US-323) — shown when the plan doesn't include AutoLister.
          The server also enforces this; this is the in-app upsell. */}
      {!entitled && !billingLoading && (
        <Card className="border-brand-red/40 bg-brand-red/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 text-brand-red-text" />
                {/* US-2872: the plan name is DERIVED. Hardcoded, it goes
                    stale silently the day the flag moves tier -- the card
                    still renders, naming the wrong plan. */}
                AutoLister comes with {autolisterGate?.requiredPlanLabel} and up
              </h2>
              <p className="text-sm text-muted-foreground">
                {autolisterGate?.what}
              </p>
            </div>
            <Button
              onClick={() =>
                useUpgradeDialogStore.getState().show({
                  reason: { type: "feature", feature: "AutoLister" },
                  currentPlan: plan,
                  requiredPlan: autolisterGate?.requiredPlan ?? "pro",
                })
              }
            >
              Upgrade to unlock
            </Button>
          </div>
        </Card>
      )}

      {/* US-2520: getting photos in is its own job, and it now lives in
          ./autolister/upload-panels.tsx. US-530 drag-and-drop + folder + paste,
          US-539 per-file progress and retry. */}
      <UploadDropzone
        entitled={entitled}
        dragging={dragging}
        onDraggingChange={setDragging}
        fileInputRef={fileInputRef}
        folderInputRef={folderInputRef}
        onFiles={(files) => void handleFiles(files)}
        onDropFiles={(transfer) => {
          void filesFromDataTransfer(transfer).then((fs) => handleFiles(fs));
        }}
        uploading={uploading}
        googlePhotos={
          gpConfigured
            ? {
                importing: gpImporting,
                progress: gpProgress,
                onImport: () => void importFromGooglePhotos(),
                onCancel: () => gpCancelRef.current?.(),
              }
            : null
        }
      />

      <UploadProgressPanel
        tasks={uploadTasks}
        uploading={uploading}
        onRetry={(ids) => void retryUploadTasks(ids)}
        onDismiss={dismissUploadTask}
      />

      {/* US-2520: both batch photo tools live in
          ./autolister/batch-photo-tools.tsx — US-536 auto-enhance and US-535
          on-device studio background. Same shape: one tap, every staged photo,
          undoable because the original is kept. */}
      {staged.length > 0 && entitled && (
        <>
          <AutoEnhanceBar
            untouchedCount={untouchedStagedCount}
            busy={enhanceBusy}
            onEnhanceAll={enhanceAll}
          />
          <StudioBackgroundBar
            mode={bgMode}
            onModeChange={setBgMode}
            untouchedCount={untouchedStagedCount}
            busy={bgBusy}
            modelProgress={modelProgress}
            onApplyAll={applyBgToAll}
          />
        </>
      )}

      {/* US-1543: one DnD context spans the ungrouped grid and the group
          cards, so photos drag between all of them (handle = grip icon;
          keyboard: focus the grip, Space lifts, arrows move, Space drops). */}
      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        onDragStart={onGroupDragStart}
        onDragEnd={onGroupDragEnd}
        onDragCancel={() => setActiveDragId(null)}
        // US-1906: dnd-kit measures droppables ONCE at drag start by default.
        // Under virtualization the group you're dragging toward usually isn't
        // mounted yet at that moment — it mounts as auto-scroll brings it into
        // view, and a droppable registered after the initial measurement would
        // never resolve as a drop target. `Always` re-measures the live set each
        // frame, so a group that was off-screen when the drag started still
        // accepts the drop once you reach it.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
      {/* Ungrouped staging area */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            Ungrouped photos {ungrouped.length > 0 && `(${ungrouped.length})`}
          </h2>
          <UngroupedToolbar
            ungroupedCount={ungrouped.length}
            entitled={entitled}
            sort={ungroupedSort}
            sortOptions={UNGROUPED_SORT_OPTIONS}
            onSortChange={(v) => setUngroupedSort(v as UngroupedSortMode)}
            canUndoAutoGroup={!!lastAutoGroupIds && lastAutoGroupIds.length > 0}
            onUndoAutoGroup={() => undoAutoGroup()}
            onAutoGroup={autoGroup}
            proposing={proposing}
            onPropose={proposeGroups}
            proposeProgress={proposeProgress}
            onStopPropose={() => {
              proposeCancelRef.current = true;
            }}
            groupEvery={groupEvery}
            onGroupEveryChange={setGroupEvery}
            onGroupEveryN={groupEveryN}
          />
        </div>
        {/* US-2621: what you do with a selection used to sit in the middle of
            the row above, between the automatic grouping tools — so the button
            you actually wanted after picking photos was the hardest one to
            find. It is its own bar now, and it sticks. */}
        <PhotoSelectionBar
          count={selected.size}
          groups={toolbarGroups}
          onNewGroup={createGroupFromSelection}
          onAddToGroup={(groupId) => movePhotos(Array.from(selected), groupId)}
          onDelete={() => removePhotos(Array.from(selected))}
          onClear={() => setSelected(new Set())}
        />
        {/* US-1904: uncertain propose boundaries — created only on the seller's
            confirmation, never silently applied. */}
        {proposalReviews.length > 0 && (
          <div
            role="region"
            aria-label="Proposed items to review"
            className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
          >
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
              {proposalReviews.length} proposed item{proposalReviews.length === 1 ? "" : "s"} the AI
              wasn't sure about — create the ones that look right:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {proposalReviews.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200"
                  title={r.reason || undefined}
                >
                  <Sparkles className="h-3 w-3 shrink-0" />
                  <span className="max-w-56 truncate">
                    {r.photoIds.length} photos · {Math.round(r.confidence * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => acceptProposalReview(r.id)}
                    className="font-semibold underline-offset-2 hover:underline"
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    aria-label={`Dismiss proposal of ${r.photoIds.length} photos, ${Math.round(r.confidence * 100)}% confident`}
                    onClick={() =>
                      setProposalReviews((prev) => prev.filter((x) => x.id !== r.id))
                    }
                    className="rounded-full p-0.5 hover:bg-amber-500/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <UngroupedDropZone>
        {ungrouped.length === 0 ? (
          <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
            {staged.length === 0
              ? "No photos yet — upload some above."
              : "All photos are grouped. Generate when ready — or drag one here to ungroup it."}
          </p>
        ) : (
          // US-1906: one absolutely-positioned virtual ROW per `gridColumns`
          // tiles. Only the rows near the viewport mount; the sized parent below
          // carries the full scroll height, so the page scrollbar still reflects
          // all 600 photos and nothing jumps as rows recycle.
          <div
            ref={gridRef}
            style={{
              height: gridVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {gridRows.map((row) => (
              <div
                key={row.key}
                className="absolute left-0 top-0 grid w-full grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7"
                style={{ transform: `translateY(${row.start - gridAnchor.offsetTop}px)` }}
              >
                {gridRowItems(ungroupedSorted, row.index, gridColumns).map((p, col) => {
              // US-2450: every tile used to announce the same two labels down
              // a whole shoot. Position counts across the GRID, not within this
              // row — see item-row-label.test.ts, which pins both.
              const photoName = tileLabel(
                stagedSortName(p),
                "photo",
                row.index * gridColumns + col + 1,
              );
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
                    aria-label={`Select ${photoName} (Shift-click selects the range)`}
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
                    aria-label={`Delete ${photoName}`}
                    onClick={() => removePhotos([p.id])}
                    disabled={processing}
                    className="absolute left-1 top-1 z-10 rounded-full bg-black/55 p-1 text-white opacity-0 hover:bg-red-600 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {/* US-535: per-photo clean / undo */}
                  {cleaned ? (
                    <button
                      type="button"
                      title="Undo background removal"
                      aria-label={`Undo background removal on ${photoName}`}
                      onClick={() => undoBg(p.id)}
                      className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Undo2 className="h-3 w-3" />
                      Undo
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        title="Clean background"
                      aria-label={`Clean the background of ${photoName}`}
                        onClick={() => applyBgToPhoto(p.id, bgMode)}
                        disabled={processing || bgBusy}
                        className="absolute bottom-1 left-1 z-10 rounded-full bg-black/55 p-1 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Eraser className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title="Auto-enhance"
                      aria-label={`Auto-enhance ${photoName}`}
                        onClick={() => void enhancePhoto(p.id)}
                        disabled={processing || enhanceBusy}
                        className="absolute bottom-1 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 p-1 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <WandSparkles className="h-3 w-3" />
                      </button>
                    </>
                  )}
                  {/* US-534: crop/rotate/straighten */}
                  <button
                    type="button"
                    title="Edit photo"
                    aria-label={`Edit ${photoName}`}
                    onClick={() => setEditingPhotoId(p.id)}
                    disabled={processing}
                    className="absolute bottom-1 right-1 z-10 rounded-full bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {/* US-1543: non-pointer fallback for adding to a group.
                      US-2621: always visible on a stray — see the prop. */}
                  <MovePhotoMenu
                    photoId={p.id}
                    currentGroupId={null}
                    groups={groups}
                    onMove={(pid, target) => movePhotos([pid], target)}
                    onNewGroup={newGroupFromPhoto}
                    className="absolute left-7 top-1"
                    alwaysVisible
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
            ))}
          </div>
        )}
        </UngroupedDropZone>
      </div>

      {/* Groups */}
      {groups.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-foreground">
              Listings to generate ({groups.length})
            </h2>
            <GroupsToolbar
              groupCount={groups.length}
              busy={busy}
              verifying={verifyingGroups}
              onVerify={() => void verifyGroups(false)}
              verifyProgress={verifyProgress}
              onStopVerify={() => {
                verifyCancelRef.current = true;
              }}
              tagging={taggingAll || taggingGroups.size > 0}
              onAutoTagAll={autoTagAllGroups}
              collapsed={groupsCollapsed}
              onToggleCollapsed={() => setGroupsCollapsed((c) => !c)}
              onUngroupAll={ungroupAll}
            />
          </div>
          {/* US-2621: everything a selection of items can do, in one bar next
              to the checkboxes that made it. */}
          <GroupSelectionBar
            count={selectedGroups.size}
            canGenerate={!busy && uploading === 0 && entitled}
            onGenerate={() => openGenerateConfirm(Array.from(selectedGroups))}
            onMerge={() => {
              mergeGroups(Array.from(selectedGroups));
              setSelectedGroups(new Set());
            }}
            onUngroup={ungroupSelectedGroups}
            onClear={() => setSelectedGroups(new Set())}
          />
          {/* US-1907: triage strip — session health + jump-to / filter for
              large sessions. Appears at ≥12 groups. */}
          {groups.length >= 12 && (
            <div
              role="region"
              aria-label="Group triage overview"
              className="sticky top-0 z-20 space-y-2 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <strong className="text-foreground">{triageSummary.totalGroups}</strong> groups
                </span>
                <span>
                  <strong className="text-foreground">{triageSummary.totalPhotos}</strong> photos
                </span>
                <span>
                  <strong className="text-foreground">{triageSummary.ungroupedCount}</strong>{" "}
                  ungrouped
                </span>
              </div>
              <div
                role="toolbar"
                aria-label="Filter groups by condition"
                className="flex flex-wrap items-center gap-1.5"
              >
                {TRIAGE_CHIPS.map((chip) => {
                  const count = triageSummary.buckets[chip.condition].length;
                  if (count === 0) return null;
                  const active = triageFilter === chip.condition;
                  return (
                    <button
                      key={chip.condition}
                      type="button"
                      aria-pressed={active}
                      aria-label={`${count} ${chip.label} — ${active ? "clear filter" : "filter to these"}`}
                      onClick={() =>
                        setTriageFilter((cur) => (cur === chip.condition ? null : chip.condition))
                      }
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200",
                      )}
                    >
                      <span className="font-semibold">{count}</span>
                      {chip.label}
                    </button>
                  );
                })}
                {triageFilter && (
                  <button
                    type="button"
                    onClick={() => setTriageFilter(null)}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <X className="h-3 w-3" />
                    Clear filter
                  </button>
                )}
              </div>
              {/* Mini-map: one slot per group; click to jump. Flagged groups
                  (any needs-attention bucket) are tinted. */}
              <nav aria-label="Jump to group" className="flex flex-wrap gap-1">
                {groups.map((g, i) => {
                  const flagged =
                    triageSummary.buckets.singleton.includes(g.id) ||
                    triageSummary.buckets.oversized.includes(g.id) ||
                    triageSummary.buckets.missing_cover_or_tag.includes(g.id) ||
                    triageSummary.buckets.has_suggestion.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => scrollToGroup(g.id)}
                      aria-label={`Jump to ${g.name || `group ${i + 1}`}${flagged ? " (needs attention)" : ""}`}
                      title={`${g.name || `Group ${i + 1}`} · ${g.photoIds.length} photo${g.photoIds.length === 1 ? "" : "s"}`}
                      className={cn(
                        "h-4 w-4 rounded-sm border text-[0px]",
                        flagged
                          ? "border-amber-500/60 bg-amber-500/30 hover:bg-amber-500/50"
                          : "border-border bg-muted hover:bg-muted-foreground/30",
                      )}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </nav>
            </div>
          )}
          {/* US-1906: virtualized group list. Cards are measured (their height
              varies), so `measureElement` re-measures each on mount and on any
              in-place growth — collapsing the photo grids doesn't need a remount
              for the offsets to settle. */}
          <div
            ref={groupsRef}
            style={{
              height: groupsVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
          {groupRows.map((row) => {
            const g = shownGroups[row.index];
            if (!g) return null;
            const groupName = g.name.trim() || `group ${row.index + 1}`;
            return (
            <div
              key={row.key}
              data-index={row.index}
              ref={groupsVirtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-3"
              style={{ transform: `translateY(${row.start - groupsAnchor.offsetTop}px)` }}
            >
            <GroupDropZone groupId={g.id}>
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
                  aria-label={`Select ${groupName}`}
                  className="h-4 w-4"
                />
                <Input
                  value={g.name}
                  onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                  className="h-8 max-w-xs"
                  aria-label={`Item name for ${groupName}`}
                  placeholder="Item name"
                />
                <Input
                  value={g.sku ?? ""}
                  onChange={(e) => updateGroup(g.id, { sku: e.target.value })}
                  className="h-8 w-28"
                  placeholder="SKU / #"
                  aria-label={`SKU for ${groupName}`}
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
                  {/* US-2621: generate THIS item without touching the rest of
                      the session. The only way to run one used to be the page
                      header's Generate, which takes the whole batch — so a
                      seller who finished one item early had to scroll to the
                      top and send everything, or wait. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openGenerateConfirm([g.id])}
                    disabled={busy || uploading > 0 || !entitled || g.photoIds.length === 0}
                    aria-label={`Generate ${groupName}`}
                    title="Send just this item to the AI now. The rest of your session stays here."
                  >
                    <Sparkles className="mr-1 h-4 w-4" />
                    Generate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => autoTagGroup(g.id)}
                    disabled={taggingGroups.has(g.id) || taggingAll}
                    aria-label={`Auto-tag ${groupName}`}
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
                    onClick={() => ungroupGroup(g.id)}
                    aria-label={`Ungroup ${groupName}`}
                    title="Break this group up — its photos go back to Ungrouped. Nothing is deleted."
                  >
                    <Ungroup className="mr-1 h-4 w-4" />
                    Ungroup
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
                        aria-label={`Dismiss suggestion: ${suggestionLabel(s, g.id)}`}
                        onClick={() => dismissSuggestion(s.id)}
                        className="rounded-full p-0.5 hover:bg-amber-500/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {!groupsCollapsed && (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {g.photoIds.map((pid, photoIndex) => {
                  const p = stagedById.get(pid);
                  if (!p) return null;
                  const isCover = g.coverId === pid;
                  const photoName = tileLabel(
                    stagedSortName(p),
                    "photo",
                    photoIndex + 1,
                  );
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
                        aria-label={`Set as cover: ${photoName}`}
                        onClick={() => setCover(g.id, pid)}
                        className={cn(
                          "absolute left-1 top-1 rounded-full p-0.5",
                          isCover
                            ? "bg-brand-red text-white"
                            : "bg-black/40 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Star className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title="Remove from group"
                        aria-label={`Remove from this group: ${photoName}`}
                        onClick={() => removePhotoFromGroup(g.id, pid)}
                        className="absolute right-1 top-1 rounded-full bg-black/40 p-0.5 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
                        aria-label={`Edit ${photoName}`}
                        onClick={() => setEditingPhotoId(pid)}
                        className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {/* US-2461 picker, US-2769 now on the cover too: cover
                          DEFAULTS to front instead of being forced to it.
                          Cover is a position; front is a fact, and
                          identification gates on this label, so a tag-first
                          shoot shipped a searchable "front" that is a tag. See
                          vault/20-domain/identification-precedence.md.
                          Group NAME is the garment word the profile reads. */}
                      <GroupPhotoTag
                        groupName={g.name}
                        photoType={g.roles?.[pid] ?? (isCover ? "front" : "detail")}
                        photoRole={g.photoRoles?.[pid] ?? null}
                        onChange={(type, role) => setPhotoTag(g.id, pid, type, role)}
                      />
                    </PhotoDragTile>
                  );
                })}
              </div>
              )}
            </Card>
            </GroupDropZone>
            </div>
            );
          })}
          </div>
          {shownGroups.length === 0 && triageFilter && (
            <FilterEmpty noun="group" total={groups.length}
              clearLabel="Clear filter" onClear={() => setTriageFilter(null)} />
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

      {/* US-2520: the three metered-action confirms live in
          ./autolister/metered-confirm-dialogs.tsx. They share one job — never
          spend an AI action without first saying how many, and how many are
          left — and keeping them together is what makes that rule checkable. */}
      <GenerateConfirmDialog
        open={confirmGenerateOpen}
        onOpenChange={setConfirmGenerateOpen}
        listableCount={generateScope.listableCount}
        stagedCount={generateScope.partial ? generateScope.photoCount : staged.length}
        // The "these photos will NOT be listed" acknowledgement is about
        // finishing the session. A partial run finishes nothing — the ungrouped
        // photos are still sitting there when it returns — so it gets the
        // neutral `partial` note below instead of a blocking checkbox.
        ungroupedCount={generateScope.partial ? 0 : ungrouped.length}
        aiActionsRemaining={aiActionsRemaining}
        groupWarnings={generateScope.warnings}
        onWarningClick={scrollToGroup}
        ackUngrouped={ackUngrouped}
        onAckUngroupedChange={setAckUngrouped}
        partial={
          generateScope.partial
            ? {
              remainingGroups: generateScope.remainingGroups,
              remainingPhotos: ungrouped.length,
            }
            : null
        }
        onGenerate={() => {
          setConfirmGenerateOpen(false);
          void generate(generateTarget);
        }}
      />

      <VerifyConfirmDialog
        confirm={verifyConfirm}
        onCancel={() => setVerifyConfirm(null)}
        aiActionsRemaining={aiActionsRemaining}
        onConfirm={(windows) => {
          setVerifyConfirm(null);
          void runVerifyWindows(windows, false);
        }}
      />

      <ProposeConfirmDialog
        confirm={proposeConfirm}
        onCancel={() => setProposeConfirm(null)}
        aiActionsRemaining={aiActionsRemaining}
        onConfirm={(windows) => {
          setProposeConfirm(null);
          void runProposeWindows(windows);
        }}
      />

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
