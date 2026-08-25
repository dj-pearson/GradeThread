import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  Layers,
  Upload,
  Loader2,
  ImageOff,
  Clock,
  HelpCircle,
  Plus,
  Scissors,
  Merge,
  MoveRight,
  Link2,
  CheckCircle2,
  XCircle,
  Sparkles,
  PackageCheck,
  ScanSearch,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EbaySkuMatch } from "@/components/flipdesk/ebay-sku-match";
import { CrossSourceConflicts } from "@/components/flipdesk/cross-source-conflicts";
import { useSyncConflicts } from "@/hooks/use-sync-conflicts";
import { ReconciliationPayoutsTab } from "@/pages/flipdesk/reconciliation";
import { supabase } from "@/lib/supabase";
import { fetchCapped } from "@/lib/paged-read";
import { useWorkspace } from "@/hooks/use-workspace";
import { readCaptureTime } from "@/lib/exif";
import {
  DEFAULT_GAP_SECONDS,
  reapplyThreshold,
  groupAssignments,
  moveToNewCluster,
  moveToCluster,
  mergeClusters,
  applyVisualSecondPass,
  type AssignmentMap,
  type ClusterablePhoto,
} from "@/lib/reconcile-cluster";
import {
  commitClusters,
  type CommitCluster,
  type CommitResult,
} from "@/hooks/use-reconcile-commit";
import {
  useBulkExtract,
  useEmbedPhotos,
  useClassifyPhotos,
  useSuggestItemMatch,
  type BulkExtractResponse,
} from "@/hooks/use-ai-extract";
import { rankItemMatches } from "@/lib/reconcile-match";
import { compressImage } from "@/lib/image-utils";
import { PhotoTagSelect } from "@/components/flipdesk/photo-tag-select";
import { usePhotoProfile, type PhotoProfile } from "@/lib/photo-profiles";
import type { FlipdeskPhotoType, ReconcileAssignmentSnapshot } from "@/types/database";
import { cn } from "@/lib/utils";
import { HelpLink } from "@/components/help/help-link";
import { Term } from "@/components/help/term";

interface DumpPhoto extends ClusterablePhoto {
  name: string;
  previewUrl: string;
  file: File | null;
  photoType: FlipdeskPhotoType;
  // US-2461: the `item_photos.photo_role` qualifier. Null for a type that takes
  // none, and for every photo restored from a session saved before this shipped.
  photoRole: string | null;
  // US-289: set when the blob is already in storage (iOS-staged). Commit
  // references it instead of re-uploading a (missing) in-memory File.
  storagePath?: string | null;
}

interface LinkTarget {
  itemId: string;
  title: string;
}
interface PhotolessItem {
  id: string;
  title: string;
  brand: string | null;
  sku: string | null;
  status: string;
}
interface CommittedItem {
  itemId: string;
  label: string;
}
interface ItemSuggestion {
  itemId: string;
  title: string;
  confidence: number;
}

// Prefer the tag (brand/size) and front shots when asking AI to match an item.
const SUGGEST_TYPE_PRIORITY: Record<string, number> = { tag: 0, front: 1, back: 2 };

const ACCEPT = "image/*";
const NEEDS_SORTING_DROP = "__needs_sorting__";
const NEW_CLUSTER_DROP = "__new_cluster__";
// item statuses eligible to receive a linked cluster (no photos yet)
const LINKABLE_STATUSES = ["sourced", "cataloged", "drafted"] as const;
// Candidates for the cluster-link picker. Well under any plausible server row
// ceiling, so the fetchCapped +1 probe is always answerable (US-2169).
const LINKABLE_PICKER_LIMIT = 200;

// US-963: the unified Reconcile area hosts four flows as tabs. The active tab is
// reflected in the `?tab=` query param so the old /reconciliation route can deep
// -link straight to its flow and tab choice survives a refresh/share.
const RECONCILE_TABS = ["photos", "ebay", "payouts", "cross-source"] as const;
type ReconcileTab = (typeof RECONCILE_TABS)[number];

export function FlipdeskReconcilePage() {
  const { workspaceOwnerId, can } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: ReconcileTab = RECONCILE_TABS.includes(tabParam as ReconcileTab)
    ? (tabParam as ReconcileTab)
    : "photos";
  const setActiveTab = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  };
  // Open cross-source conflict count for the tab badge (US-148).
  const { data: conflicts } = useSyncConflicts();
  const [photos, setPhotos] = useState<DumpPhoto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gapSeconds, setGapSeconds] = useState(DEFAULT_GAP_SECONDS);
  const [ingesting, setIngesting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [linkTargets, setLinkTargets] = useState<Record<string, LinkTarget>>({});
  const [committing, setCommitting] = useState(false);
  const [results, setResults] = useState<CommitResult[] | null>(null);
  const [committed, setCommitted] = useState<CommittedItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bulkExtract = useBulkExtract();
  const embedPhotos = useEmbedPhotos();
  const classifyPhotos = useClassifyPhotos();
  const suggestMatch = useSuggestItemMatch();
  const [visualPending, setVisualPending] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, ItemSuggestion>>({});
  const [suggestingId, setSuggestingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // Photo-less items the user can link a cluster to (US-285).
  const { data: linkableRead } = useQuery({
    queryKey: ["reconcile_linkable_items", workspaceOwnerId],
    enabled: !!workspaceOwnerId && photos.length > 0,
    staleTime: 60_000,
    // US-2169: both predicates now run SERVER-side. They used to run on the
    // client, over whichever 200 items happened to be the most recently
    // updated — so a seller whose 200 latest touches were all photographed saw
    // an EMPTY picker while plenty of linkable items existed. That is worse
    // than truncation: the cap silently selected the wrong 200 rows. Filtering
    // first means the limit applies to real candidates, and `truncated` then
    // means what it says.
    queryFn: () =>
      fetchCapped<PhotolessItem>(async (limit) => {
        const { data, error } = await supabase
          .from("items_full")
          .select("id, item_title, brand, item_number, status")
          .eq("photo_count", 0)
          .in("status", [...LINKABLE_STATUSES])
          .order("updated_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        const rows = (data ?? []) as Array<{
          id: string;
          item_title: string;
          brand: string | null;
          item_number: string | null;
          status: string;
        }>;
        return rows.map((r) => ({
          id: r.id,
          title: r.item_title,
          brand: r.brand,
          sku: r.item_number,
          status: r.status,
        }));
      }, LINKABLE_PICKER_LIMIT),
  });
  const linkableItems = useMemo<PhotolessItem[]>(
    () => linkableRead?.rows ?? [],
    [linkableRead],
  );

  // Restore an in-progress session on mount.
  useEffect(() => {
    if (!workspaceOwnerId || restored) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("flipdesk_reconcile_sessions")
        .select("id, gap_seconds, assignments")
        .eq("user_id", workspaceOwnerId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // Don't silently drop an in-progress reconcile board on a transient
        // failure. Surface it and leave `restored` false so a reload retries.
        toast.error("Couldn't restore your in-progress reconcile session. Reload to retry.");
        return;
      }
      setRestored(true);
      const row = data as
        | { id: string; gap_seconds: number; assignments: ReconcileAssignmentSnapshot[] }
        | null;
      if (!row || !row.assignments?.length) return;
      setSessionId(row.id);
      setGapSeconds(row.gap_seconds ?? DEFAULT_GAP_SECONDS);
      const restoredPhotos: DumpPhoto[] = [];
      const map: AssignmentMap = {};
      for (const a of row.assignments) {
        // US-289: iOS-staged photos already live in storage — hydrate a preview
        // from the public URL so the board shows real thumbnails (not blanks)
        // and keep storagePath so commit reuses the object.
        const previewUrl = a.storagePath
          ? supabase.storage.from("item-photos").getPublicUrl(a.storagePath).data.publicUrl
          : "";
        restoredPhotos.push({
          id: a.id,
          name: a.name,
          capturedAt: a.capturedAt ? new Date(a.capturedAt) : null,
          previewUrl,
          file: null,
          photoType: a.photoType ?? "detail",
          photoRole: a.photoRole ?? null,
          storagePath: a.storagePath ?? null,
        });
        map[a.id] = { clusterId: a.clusterId, manual: a.manual };
      }
      setPhotos(restoredPhotos);
      setAssignments(map);
      toast.info("Restored your in-progress reconcile session.");
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceOwnerId, restored]);

  useEffect(() => {
    return () => {
      for (const p of photos) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { clusters, needsSorting } = useMemo(
    () => groupAssignments(photos, assignments),
    [photos, assignments],
  );

  // Persist assignment snapshot + threshold (debounced, best-effort).
  useEffect(() => {
    if (!sessionId || photos.length === 0) return;
    const snapshot: ReconcileAssignmentSnapshot[] = photos.map((p) => ({
      id: p.id,
      capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
      name: p.name,
      clusterId: assignments[p.id]?.clusterId ?? null,
      manual: assignments[p.id]?.manual ?? false,
      // US-289: preserve the storage pointer for iOS-staged photos.
      storagePath: p.storagePath ?? null,
      photoType: p.photoType,
      photoRole: p.photoRole,
    }));
    const t = setTimeout(() => {
      void supabase
        .from("flipdesk_reconcile_sessions")
        .update({ assignments: snapshot, gap_seconds: gapSeconds, photo_count: photos.length } as never)
        .eq("id", sessionId);
    }, 600);
    return () => clearTimeout(t);
  }, [sessionId, photos, assignments, gapSeconds]);

  const ensureSession = useCallback(
    async (existing: string | null): Promise<string | null> => {
      if (existing) return existing;
      if (!workspaceOwnerId) return null;
      const { data, error } = await supabase
        .from("flipdesk_reconcile_sessions")
        .insert({ user_id: workspaceOwnerId, gap_seconds: gapSeconds } as never)
        .select("id")
        .single();
      if (error) {
        toast.error("Could not start a reconcile session; grouping still works.");
        return null;
      }
      const id = (data as { id: string }).id;
      setSessionId(id);
      return id;
    },
    [workspaceOwnerId, gapSeconds],
  );

  const ingest = useCallback(
    async (fileList: FileList | File[]) => {
      if (!can("manage_inventory")) {
        toast.error("You don't have permission to manage inventory in this workspace.");
        return;
      }
      const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      setIngesting(true);
      await ensureSession(sessionId);
      try {
        let batch: DumpPhoto[] = [];
        const flush = () => {
          if (batch.length === 0) return;
          const add = batch;
          batch = [];
          setPhotos((prev) => {
            const next = [...prev, ...add];
            setAssignments((prevMap) => reapplyThreshold(prevMap, next, gapSeconds));
            return next;
          });
        };
        for (const file of files) {
          const capturedAt = await readCaptureTime(file);
          batch.push({
            id: crypto.randomUUID(),
            name: file.name,
            capturedAt,
            previewUrl: URL.createObjectURL(file),
            file,
            photoType: "detail",
            photoRole: null,
          });
          if (batch.length >= 12) flush();
        }
        flush();
      } finally {
        setIngesting(false);
      }
    },
    [can, ensureSession, sessionId, gapSeconds],
  );

  function onGapChange(next: number) {
    setGapSeconds(next);
    setAssignments((prev) => reapplyThreshold(prev, photos, next));
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // US-2461: a tag is a (type, role) pair, so both move together or neither does.
  function setPhotoType(id: string, type: FlipdeskPhotoType, role: string | null) {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, photoType: type, photoRole: role } : p)),
    );
  }

  const selectedIds = useMemo(() => [...selected], [selected]);

  function applyMoveToNew() {
    setAssignments((prev) => moveToNewCluster(prev, selectedIds));
    setSelected(new Set());
  }
  function applyMoveTo(clusterId: string | null) {
    setAssignments((prev) => moveToCluster(prev, selectedIds, clusterId));
    setSelected(new Set());
  }
  function applyMerge(into: string, from: string) {
    setAssignments((prev) => mergeClusters(prev, into, from));
  }

  function onDragEnd(e: DragEndEvent) {
    const photoId = String(e.active.id);
    const over = e.over?.id;
    if (over == null) return;
    if (over === NEW_CLUSTER_DROP) setAssignments((prev) => moveToNewCluster(prev, [photoId]));
    else if (over === NEEDS_SORTING_DROP) setAssignments((prev) => moveToCluster(prev, [photoId], null));
    else setAssignments((prev) => moveToCluster(prev, [photoId], String(over)));
  }

  function reset() {
    for (const p of photos) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPhotos([]);
    setAssignments({});
    setSelected(new Set());
    setLinkTargets({});
    setCommitted([]);
    setSessionId(null);
  }

  async function commit() {
    if (!workspaceOwnerId || clusters.length === 0) return;
    setCommitting(true);
    try {
      const payload: CommitCluster[] = clusters.map((c, i) => ({
        clusterId: c.clusterId,
        label: linkTargets[c.clusterId]?.title ?? `Item ${i + 1}`,
        linkItemId: linkTargets[c.clusterId]?.itemId ?? null,
        titleHint: undefined,
        photos: c.photos.map((p) => ({
          id: p.id,
          file: p.file,
          capturedAt: p.capturedAt,
          photoType: p.photoType,
          photoRole: p.photoRole,
          storagePath: p.storagePath ?? null,
        })),
      }));
      const res = await commitClusters(payload, workspaceOwnerId, sessionId);
      setResults(res);
      const okItems = res
        .filter((r) => r.ok && r.itemId)
        .map((r) => ({ itemId: r.itemId!, label: r.title }));
      setCommitted(okItems);
      const failed = res.filter((r) => !r.ok).length;
      if (failed === 0) toast.success(`Committed ${res.length} item(s) to your pipeline.`);
      else toast.warning(`${res.length - failed} committed, ${failed} failed — see details.`);

      // US-286: classify each committed item's photos (best-effort; failures
      // leave photos as 'detail' and never block). User corrections made before
      // commit are respected — the server only overwrites the generic default.
      for (const it of okItems) {
        try {
          await classifyPhotos.mutateAsync({ item_id: it.itemId });
        } catch {
          /* fall back to existing photo types */
        }
      }
    } finally {
      setCommitting(false);
    }
  }

  // US-283: opt-in visual second pass. Downscales each photo, asks the edge for
  // same-garment pairs, then merges those time clusters — never touching manual
  // edits. On any failure the time-gap grouping stands and the user is told.
  async function runVisualPass() {
    const withFiles = photos.filter((p) => p.file);
    if (withFiles.length < 2) {
      toast.info("Need at least 2 photos with image data for the visual pass.");
      return;
    }
    if (withFiles.length > 40) {
      toast.info("The visual pass handles up to 40 photos at a time.");
      return;
    }
    setVisualPending(true);
    try {
      const visionPhotos = [];
      for (const p of withFiles) {
        const small = await compressImage(p.file!, 512, 0.6);
        visionPhotos.push({
          id: p.id,
          data: await blobToBase64(small.blob),
          media_type: small.blob.type || "image/jpeg",
        });
      }
      const resp = await embedPhotos.mutateAsync({ photos: visionPhotos });
      if (resp.pairs.length === 0) {
        toast.info("Visual pass found no additional same-item photos.");
        return;
      }
      setAssignments((prev) => applyVisualSecondPass(prev, resp.pairs));
      toast.success(`Visual pass grouped ${resp.pairs.length} similar pair(s).`);
    } catch {
      toast.warning("Visual pass was skipped — kept your time-based grouping.");
    } finally {
      setVisualPending(false);
    }
  }

  // US-285: AI-suggest the most likely existing item for a cluster. Reads the
  // brand/tag from the cluster's photos, ranks the owner's photo-less items,
  // and surfaces the top match — never auto-applied (the user must accept it).
  async function suggestForCluster(clusterId: string, clusterPhotos: DumpPhoto[]) {
    const withFiles = clusterPhotos.filter((p) => p.file);
    if (withFiles.length === 0) {
      toast.info("Re-add this group's photos to use AI suggest.");
      return;
    }
    if (linkableItems.length === 0) {
      toast.info("No photo-less items to match against.");
      return;
    }
    const ordered = [...withFiles]
      .sort((a, b) => (SUGGEST_TYPE_PRIORITY[a.photoType] ?? 9) - (SUGGEST_TYPE_PRIORITY[b.photoType] ?? 9))
      .slice(0, 4);
    setSuggestingId(clusterId);
    try {
      const visionPhotos = [];
      for (const p of ordered) {
        const small = await compressImage(p.file!, 512, 0.6);
        visionPhotos.push({
          id: p.id,
          data: await blobToBase64(small.blob),
          media_type: small.blob.type || "image/jpeg",
        });
      }
      const hints = await suggestMatch.mutateAsync({ photos: visionPhotos });
      const ranked = rankItemMatches(
        { brand: hints.brand, keywords: hints.keywords },
        linkableItems.map((it) => ({ id: it.id, title: it.title, brand: it.brand, sku: it.sku })),
      );
      if (ranked.length === 0) {
        toast.info("No likely match found — search manually.");
        return;
      }
      const top = ranked[0]!;
      const item = linkableItems.find((it) => it.id === top.id);
      if (!item) return;
      setSuggestions((prev) => ({
        ...prev,
        [clusterId]: { itemId: item.id, title: item.title, confidence: Math.round(top.score * 100) },
      }));
      toast.success(`Suggested match: ${item.title}`);
    } catch {
      toast.warning("Couldn't suggest a match — search manually.");
    } finally {
      setSuggestingId(null);
    }
  }

  async function generate(itemIds: string[]) {
    if (itemIds.length === 0) return;
    try {
      const resp: BulkExtractResponse = await bulkExtract.mutateAsync({ item_ids: itemIds });
      toast.success(
        `Generated: ${resp.summary.enriched} applied, ${resp.summary.needs_review} need review.`,
      );
    } catch {
      /* useBulkExtract surfaces its own error toast */
    }
  }

  const timedCount = photos.length - needsSorting.length;
  const clusterLabel = (clusterId: string) =>
    `Item ${clusters.findIndex((c) => c.clusterId === clusterId) + 1}`;
  const committable = clusters.length > 0 && committed.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Layers}
        title="Reconcile"
        subtitle={
          <>
            Sort a pile of photos into items, match them to your eBay{" "}
            <Term name="SKU">SKUs</Term>, and check your payouts and fees
            against what actually sold.
          </>
        }
              actions={<HelpLink slug="reconciling-payouts" label="Help: reconciling payouts" />}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="photos">Photos &rarr; Items</TabsTrigger>
          <TabsTrigger value="ebay">eBay SKU match</TabsTrigger>
          <TabsTrigger value="payouts">Payouts &amp; fees</TabsTrigger>
          <TabsTrigger value="cross-source">
            Cross-source
            {(conflicts?.total ?? 0) > 0 && (
              <Badge variant="destructive" className="ml-1.5 px-1.5 text-[10px]">
                {conflicts!.total}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="photos" className="mt-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Layers className="h-5 w-5 text-primary" />
                Photo Dump Reconcile
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Drop a whole haul at once, fix the grouping, set photo types, then commit
                each group as an inventory item.
              </p>
            </div>
            {photos.length > 0 && (
              <Button variant="outline" size="sm" onClick={reset}>
                Clear
              </Button>
            )}
          </div>

      {/* Drop zone */}
      <Card>
        <CardContent className="pt-6">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) void ingest(e.dataTransfer.files);
            }}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors",
              dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50",
            )}
          >
            {ingesting ? (
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            ) : (
              <Upload className="h-8 w-8 text-muted-foreground" />
            )}
            <div className="text-sm font-medium text-foreground">
              {ingesting ? "Reading capture times…" : "Drop photos here or click to browse"}
            </div>
            <div className="text-xs text-muted-foreground">
              Drag in your whole haul — JPEG/PNG/HEIC, hundreds at a time.
            </div>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void ingest(e.target.files);
              e.target.value = "";
            }}
          />
        </CardContent>
      </Card>

      {photos.length > 0 && (
        <>
          {/* Counts + slider + commit */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{photos.length} photos</Badge>
                  <Badge variant="secondary">{clusters.length} proposed items</Badge>
                  {needsSorting.length > 0 && (
                    <Badge variant="outline">{needsSorting.length} need sorting</Badge>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Label htmlFor="gap" className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" /> Gap: {gapSeconds}s
                  </Label>
                  <input
                    id="gap"
                    type="range"
                    min={5}
                    max={300}
                    step={5}
                    value={gapSeconds}
                    onChange={(e) => onGapChange(Number(e.target.value))}
                    className="h-2 w-44 cursor-pointer accent-primary"
                  />
                  {committable && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={runVisualPass}
                        disabled={visualPending}
                        title="Use AI to group same-item photos shot out of order"
                      >
                        {visualPending ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ScanSearch className="mr-1 h-3.5 w-3.5" />
                        )}
                        Group similar
                      </Button>
                      <Button size="sm" onClick={commit} disabled={committing}>
                        {committing ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <PackageCheck className="mr-1 h-3.5 w-3.5" />
                        )}
                        Commit {clusters.length} item{clusters.length === 1 ? "" : "s"}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <CardDescription>
                A gap of {gapSeconds}s or more starts a new item group. {timedCount} of{" "}
                {photos.length} photos have a capture time. Manual edits survive a gap change.
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Committed items → generate title/details (US-288) */}
          {committed.length > 0 && (
            <Card className="border-green-300/60 dark:border-green-800/60">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    Committed {committed.length} item{committed.length === 1 ? "" : "s"}
                  </CardTitle>
                  <CardDescription>Generate titles &amp; details with AI, or do it later.</CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => generate(committed.map((c) => c.itemId))}
                  disabled={bulkExtract.isPending}
                >
                  {bulkExtract.isPending ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                  )}
                  Generate all
                </Button>
              </CardHeader>
              <CardContent className="space-y-1">
                {committed.map((c) => (
                  <div key={c.itemId} className="flex items-center justify-between rounded border px-3 py-1.5 text-sm">
                    <span>{c.label}</span>
                    <Button
                    aria-label={`Generate for ${c.label}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => generate([c.itemId])}
                      disabled={bulkExtract.isPending}
                    >
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Selection action bar */}
          {selected.size > 0 && committed.length === 0 && (
            <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
              <span className="text-sm font-medium">{selected.size} selected</span>
              <Button size="sm" variant="outline" onClick={applyMoveToNew}>
                <Scissors className="mr-1 h-3.5 w-3.5" /> Move to new item
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <MoveRight className="mr-1 h-3.5 w-3.5" /> Move to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>Move {selected.size} photo(s) to</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {clusters.map((c, i) => (
                    <DropdownMenuItem key={c.clusterId} onClick={() => applyMoveTo(c.clusterId)}>
                      Item {i + 1} <span className="ml-1 text-muted-foreground">· {c.photos.length}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => applyMoveTo(null)}>Needs sorting</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          )}

          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="space-y-4">
              {clusters.map((cluster, i) => (
                <ClusterCard
                  key={cluster.clusterId}
                  clusterId={cluster.clusterId}
                  index={i}
                  photos={cluster.photos}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onSetPhotoType={setPhotoType}
                  locked={committed.length > 0}
                  otherClusters={clusters
                    .filter((c) => c.clusterId !== cluster.clusterId)
                    .map((c) => ({ id: c.clusterId, label: clusterLabel(c.clusterId) }))}
                  onMerge={(from) => applyMerge(cluster.clusterId, from)}
                  linkTarget={linkTargets[cluster.clusterId] ?? null}
                  linkableItems={linkableItems}
                  linkableTruncated={linkableRead?.truncated ?? false}
                  onLink={(t) =>
                    setLinkTargets((prev) => {
                      const next = { ...prev };
                      if (t) next[cluster.clusterId] = t;
                      else delete next[cluster.clusterId];
                      return next;
                    })
                  }
                  suggestion={suggestions[cluster.clusterId] ?? null}
                  suggesting={suggestingId === cluster.clusterId}
                  onSuggest={() => suggestForCluster(cluster.clusterId, cluster.photos)}
                />
              ))}
              {committed.length === 0 && <NewClusterDropZone />}
            </div>

            <NeedsSortingZone
              photos={needsSorting}
              selected={selected}
              onToggleSelect={toggleSelect}
              onSetPhotoType={setPhotoType}
            />
          </DndContext>
        </>
      )}
        </TabsContent>

        <TabsContent value="ebay" className="mt-6">
          <EbaySkuMatch />
        </TabsContent>

        <TabsContent value="payouts" className="mt-6">
          <ReconciliationPayoutsTab />
        </TabsContent>

        <TabsContent value="cross-source" className="mt-6">
          <CrossSourceConflicts />
        </TabsContent>
      </Tabs>

      <CommitResultsDialog results={results} onClose={() => setResults(null)} />
    </div>
  );
}

function ClusterCard({
  clusterId,
  index,
  photos,
  selected,
  onToggleSelect,
  onSetPhotoType,
  locked,
  otherClusters,
  onMerge,
  linkTarget,
  linkableItems,
  linkableTruncated,
  onLink,
  suggestion,
  suggesting,
  onSuggest,
}: {
  clusterId: string;
  index: number;
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetPhotoType: (id: string, t: FlipdeskPhotoType, role: string | null) => void;
  locked: boolean;
  otherClusters: Array<{ id: string; label: string }>;
  onMerge: (fromClusterId: string) => void;
  linkTarget: LinkTarget | null;
  linkableItems: PhotolessItem[];
  linkableTruncated: boolean;
  onLink: (t: LinkTarget | null) => void;
  suggestion: ItemSuggestion | null;
  suggesting: boolean;
  onSuggest: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: clusterId, disabled: locked });
  return (
    <Card
      ref={setNodeRef}
      className={cn("transition-colors", isOver && "border-primary ring-2 ring-primary/40")}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <CardTitle className="text-base">
            Item {index + 1}{" "}
            <span className="font-normal text-muted-foreground">
              · {photos.length} photo{photos.length === 1 ? "" : "s"}
            </span>
          </CardTitle>
          <CardDescription>
            {linkTarget ? (
              <span className="text-primary">Will link to: {linkTarget.title}</span>
            ) : (
              formatRange(photos)
            )}
          </CardDescription>
        </div>
        {!locked && (
          <div className="flex items-center gap-1">
            <LinkPicker
              items={linkableItems}
              truncated={linkableTruncated}
              current={linkTarget}
              onLink={onLink}
              suggestion={suggestion}
              suggesting={suggesting}
              onSuggest={onSuggest}
            />
            {otherClusters.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    <Merge className="mr-1 h-3.5 w-3.5" /> Merge
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Merge another item into this one</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {otherClusters.map((c) => (
                    <DropdownMenuItem key={c.id} onClick={() => onMerge(c.id)}>
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <ThumbGrid
          photos={photos}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onSetPhotoType={onSetPhotoType}
          editable={!locked}
        />
      </CardContent>
    </Card>
  );
}

function LinkPicker({
  items,
  truncated,
  current,
  onLink,
  suggestion,
  suggesting,
  onSuggest,
}: {
  items: PhotolessItem[];
  /** True when the candidate pool itself was capped — US-2169. */
  truncated: boolean;
  current: LinkTarget | null;
  onLink: (t: LinkTarget | null) => void;
  suggestion: ItemSuggestion | null;
  suggesting: boolean;
  onSuggest: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 50);
    return items
      .filter(
        (it) =>
          it.title.toLowerCase().includes(needle) ||
          (it.brand ?? "").toLowerCase().includes(needle) ||
          (it.sku ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [items, q]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <Link2 className="mr-1 h-3.5 w-3.5" /> {current ? "Linked" : "Link"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Link to a photo-less item
          </span>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onSuggest} disabled={suggesting}>
            {suggesting ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            Suggest
          </Button>
        </div>
        {/* AI suggestion, surfaced first and never auto-applied (US-285). */}
        {suggestion && (
          <button
            type="button"
            onClick={() => {
              onLink({ itemId: suggestion.itemId, title: suggestion.title });
              setOpen(false);
            }}
            className="mb-2 flex w-full items-center justify-between rounded border border-primary/40 bg-primary/5 px-2 py-1.5 text-left text-sm hover:bg-primary/10"
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1 text-xs font-medium text-primary">
                <Sparkles className="h-3 w-3" /> Suggested match
              </span>
              <span className="truncate">{suggestion.title}</span>
            </span>
            <Badge variant="secondary" className="ml-1 shrink-0 text-[10px]">
              {suggestion.confidence}%
            </Badge>
          </button>
        )}
        <Input
          aria-label="Search items to reconcile"
          placeholder="Search title / brand / SKU…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mb-2 h-8"
        />
        {current && (
          <Button
            size="sm"
            variant="ghost"
            className="mb-1 w-full justify-start text-destructive"
            onClick={() => {
              onLink(null);
              setOpen(false);
            }}
          >
            Unlink (create new draft instead)
          </Button>
        )}
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No photo-less items match.
              {/* US-2169: a search that finds nothing against a CAPPED pool
                  reads as "you have no such item", which is a different claim
                  from "it isn't in the newest few hundred". Say which. */}
              {truncated && (
                <span className="mt-1 block">
                  Only the {LINKABLE_PICKER_LIMIT} most recently updated were
                  searched.
                </span>
              )}
            </div>
          )}
          {filtered.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => {
                onLink({ itemId: it.id, title: it.title });
                setOpen(false);
              }}
              className="flex w-full flex-col rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="truncate font-medium">{it.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[it.brand, it.sku, it.status].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NewClusterDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: NEW_CLUSTER_DROP });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-xs text-muted-foreground transition-colors",
        isOver ? "border-primary bg-primary/5 text-primary" : "border-muted-foreground/25",
      )}
    >
      <Plus className="h-4 w-4" /> Drag a photo here to start a new item
    </div>
  );
}

function NeedsSortingZone({
  photos,
  selected,
  onToggleSelect,
  onSetPhotoType,
}: {
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetPhotoType: (id: string, t: FlipdeskPhotoType, role: string | null) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: NEEDS_SORTING_DROP });
  if (photos.length === 0 && !isOver) return null;
  return (
    <Card
      ref={setNodeRef}
      className={cn("mt-4 border-amber-300/60 transition-colors dark:border-amber-800/60", isOver && "border-primary ring-2 ring-primary/40")}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="h-4 w-4 text-amber-500" />
          Needs sorting
          <span className="font-normal text-muted-foreground">
            · {photos.length} photo{photos.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <CardDescription>
          No capture time, or moved here manually. Select or drag them into an item.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ThumbGrid
          photos={photos}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onSetPhotoType={onSetPhotoType}
          editable
        />
      </CardContent>
    </Card>
  );
}

function ThumbGrid({
  photos,
  selected,
  onToggleSelect,
  onSetPhotoType,
  editable,
}: {
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetPhotoType: (id: string, t: FlipdeskPhotoType, role: string | null) => void;
  editable: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
      {photos.map((p) => (
        <Thumb
          key={p.id}
          photo={p}
          selected={selected.has(p.id)}
          onToggleSelect={() => onToggleSelect(p.id)}
          onSetPhotoType={(t, role) => onSetPhotoType(p.id, t, role)}
          editable={editable}
        />
      ))}
    </div>
  );
}

function Thumb({
  photo,
  selected,
  onToggleSelect,
  onSetPhotoType,
  editable,
}: {
  photo: DumpPhoto;
  selected: boolean;
  onToggleSelect: () => void;
  onSetPhotoType: (t: FlipdeskPhotoType, role: string | null) => void;
  editable: boolean;
}) {
  // US-2461: the reconcile board holds loose photos that have no item yet, so
  // there is no garment word to resolve — this is the flat clothing profile,
  // which is the right default for a board a clothing reseller dumped a card
  // into. The query is shared, so one fetch serves every thumb.
  const profile: PhotoProfile = usePhotoProfile(null, null);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: photo.id,
    disabled: !editable,
  });
  return (
    <div className={cn("space-y-1", isDragging && "opacity-30")}>
      <div
        ref={setNodeRef}
        {...(editable ? attributes : {})}
        {...(editable ? listeners : {})}
        className={cn(
          "relative aspect-square overflow-hidden rounded-md border bg-muted",
          editable && "cursor-grab",
          selected && "ring-2 ring-primary",
        )}
      >
        {editable && (
          <div
            className="absolute left-1 top-1 z-10"
            role="presentation"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label="Select photo"
              className="h-4 w-4 cursor-pointer accent-primary"
            />
          </div>
        )}
        {photo.previewUrl ? (
          <img src={photo.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-center">
            <ImageOff className="h-4 w-4 text-muted-foreground" />
            <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">{photo.name}</span>
          </div>
        )}
      </div>
      {/* Inline photo-type correction (US-286). US-2461: the one picker — this
          used to map FLIPDESK_PHOTO_TYPES into a flat 28-entry list, retired
          types and all. */}
      <div onPointerDown={(e) => e.stopPropagation()}>
        <PhotoTagSelect
          photoType={photo.photoType}
          photoRole={photo.photoRole}
          profile={profile}
          onChange={onSetPhotoType}
          disabled={!editable}
          ariaLabel="Photo type"
          className="h-auto w-full px-1 py-0.5 text-[10px]"
        />
      </div>
    </div>
  );
}

function CommitResultsDialog({
  results,
  onClose,
}: {
  results: CommitResult[] | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!results} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Commit results</DialogTitle>
          <DialogDescription>
            {results?.filter((r) => r.ok).length ?? 0} of {results?.length ?? 0} items committed.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {results?.map((r) => (
            <div key={r.clusterId} className="flex items-start gap-2 rounded border px-3 py-2 text-sm">
              {r.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              )}
              <div>
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-muted-foreground">{r.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function formatRange(cluster: DumpPhoto[]): string {
  const timed = cluster.filter((p) => p.capturedAt);
  const first = timed[0]?.capturedAt;
  const last = timed[timed.length - 1]?.capturedAt;
  if (!first || !last) return "Capture time unknown";
  const fmt = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return first.getTime() === last.getTime() ? `Shot at ${fmt(first)}` : `Shot ${fmt(first)} – ${fmt(last)}`;
}
