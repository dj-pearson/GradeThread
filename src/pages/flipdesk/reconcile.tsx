import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";
import { readCaptureTime } from "@/lib/exif";
import {
  DEFAULT_GAP_SECONDS,
  reapplyThreshold,
  groupAssignments,
  moveToNewCluster,
  moveToCluster,
  mergeClusters,
  type AssignmentMap,
  type ClusterablePhoto,
} from "@/lib/reconcile-cluster";
import type { ReconcileAssignmentSnapshot } from "@/types/database";
import { cn } from "@/lib/utils";

// A photo as held in the reconcile UI before it's committed to inventory.
// `previewUrl` is empty for entries restored from a persisted session (the blob
// is gone on reload) until the same file is re-dropped.
interface DumpPhoto extends ClusterablePhoto {
  name: string;
  previewUrl: string;
}

const ACCEPT = "image/*";
const NEEDS_SORTING_DROP = "__needs_sorting__";
const NEW_CLUSTER_DROP = "__new_cluster__";

export function FlipdeskReconcilePage() {
  const { workspaceOwnerId, can } = useWorkspace();
  const [photos, setPhotos] = useState<DumpPhoto[]>([]);
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gapSeconds, setGapSeconds] = useState(DEFAULT_GAP_SECONDS);
  const [ingesting, setIngesting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // Restore an in-progress (open) session on mount so a reload brings the
  // cluster structure back. Photos come back as thumbnail-less placeholders.
  useEffect(() => {
    if (!workspaceOwnerId || restored) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("flipdesk_reconcile_sessions")
        .select("id, gap_seconds, assignments")
        .eq("user_id", workspaceOwnerId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
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
        restoredPhotos.push({
          id: a.id,
          name: a.name,
          capturedAt: a.capturedAt ? new Date(a.capturedAt) : null,
          previewUrl: "",
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

  // Release object URLs on unmount.
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

  // Persist the assignment snapshot + threshold (best-effort, debounced).
  useEffect(() => {
    if (!sessionId || photos.length === 0) return;
    const snapshot: ReconcileAssignmentSnapshot[] = photos.map((p) => ({
      id: p.id,
      capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
      name: p.name,
      clusterId: assignments[p.id]?.clusterId ?? null,
      manual: assignments[p.id]?.manual ?? false,
    }));
    const t = setTimeout(() => {
      void supabase
        .from("flipdesk_reconcile_sessions")
        .update({
          assignments: snapshot,
          gap_seconds: gapSeconds,
          photo_count: photos.length,
        } as never)
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
        // Read EXIF capture time from the ORIGINAL file before compression
        // strips it. Awaiting per file yields to the event loop; flush in
        // batches so a 100+ photo drop fills progressively without freezing.
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

  // Re-cluster non-manual photos live when the slider moves.
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
    if (over === NEW_CLUSTER_DROP) {
      setAssignments((prev) => moveToNewCluster(prev, [photoId]));
    } else if (over === NEEDS_SORTING_DROP) {
      setAssignments((prev) => moveToCluster(prev, [photoId], null));
    } else {
      setAssignments((prev) => moveToCluster(prev, [photoId], String(over)));
    }
  }

  function reset() {
    for (const p of photos) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPhotos([]);
    setAssignments({});
    setSelected(new Set());
    setSessionId(null);
  }

  const timedCount = photos.length - needsSorting.length;
  const clusterLabel = (clusterId: string) =>
    `Item ${clusters.findIndex((c) => c.clusterId === clusterId) + 1}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Layers className="h-6 w-6 text-primary" />
            Photo Dump Reconcile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop a whole haul at once. We group photos into proposed items by
            capture time — adjust the gap, then fix grouping by hand (select, move,
            merge, split, or drag).
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
          {/* Counts + threshold slider */}
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
                </div>
              </div>
              <CardDescription>
                A gap of {gapSeconds}s or more starts a new item group. {timedCount} of{" "}
                {photos.length} photos have a capture time. Manual edits are kept when
                you change the gap.
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Selection action bar */}
          {selected.size > 0 && (
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
                      Item {i + 1}{" "}
                      <span className="ml-1 text-muted-foreground">· {c.photos.length}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => applyMoveTo(null)}>
                    Needs sorting
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          )}

          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {/* Proposed clusters */}
            <div className="space-y-4">
              {clusters.map((cluster, i) => (
                <ClusterCard
                  key={cluster.clusterId}
                  clusterId={cluster.clusterId}
                  index={i}
                  photos={cluster.photos}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  otherClusters={clusters
                    .filter((c) => c.clusterId !== cluster.clusterId)
                    .map((c) => ({ id: c.clusterId, label: clusterLabel(c.clusterId) }))}
                  onMerge={(from) => applyMerge(cluster.clusterId, from)}
                />
              ))}

              {/* Drop target to spin off a new cluster */}
              <NewClusterDropZone />
            </div>

            {/* Needs-sorting bucket */}
            <NeedsSortingZone
              photos={needsSorting}
              selected={selected}
              onToggleSelect={toggleSelect}
            />
          </DndContext>
        </>
      )}
    </div>
  );
}

function ClusterCard({
  clusterId,
  index,
  photos,
  selected,
  onToggleSelect,
  otherClusters,
  onMerge,
}: {
  clusterId: string;
  index: number;
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  otherClusters: Array<{ id: string; label: string }>;
  onMerge: (fromClusterId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: clusterId });
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
          <CardDescription>{formatRange(photos)}</CardDescription>
        </div>
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
      </CardHeader>
      <CardContent>
        <ThumbGrid photos={photos} selected={selected} onToggleSelect={onToggleSelect} />
      </CardContent>
    </Card>
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
}: {
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: NEEDS_SORTING_DROP });
  if (photos.length === 0 && !isOver) return null;
  return (
    <Card
      ref={setNodeRef}
      className={cn(
        "mt-4 border-amber-300/60 transition-colors",
        isOver && "border-primary ring-2 ring-primary/40",
      )}
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
        <ThumbGrid photos={photos} selected={selected} onToggleSelect={onToggleSelect} />
      </CardContent>
    </Card>
  );
}

function ThumbGrid({
  photos,
  selected,
  onToggleSelect,
}: {
  photos: DumpPhoto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
      {photos.map((p) => (
        <Thumb
          key={p.id}
          photo={p}
          selected={selected.has(p.id)}
          onToggleSelect={() => onToggleSelect(p.id)}
        />
      ))}
    </div>
  );
}

function Thumb({
  photo,
  selected,
  onToggleSelect,
}: {
  photo: DumpPhoto;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: photo.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "relative aspect-square cursor-grab overflow-hidden rounded-md border bg-muted",
        selected && "ring-2 ring-primary",
        isDragging && "opacity-30",
      )}
    >
      <div
        className="absolute left-1 top-1 z-10"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label="Select photo"
          className="h-4 w-4 cursor-pointer accent-primary"
        />
      </div>
      {photo.previewUrl ? (
        <img src={photo.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-center">
          <ImageOff className="h-4 w-4 text-muted-foreground" />
          <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">
            {photo.name}
          </span>
        </div>
      )}
    </div>
  );
}

function formatRange(cluster: DumpPhoto[]): string {
  const timed = cluster.filter((p) => p.capturedAt);
  const first = timed[0]?.capturedAt;
  const last = timed[timed.length - 1]?.capturedAt;
  if (!first || !last) return "Capture time unknown";
  const fmt = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return first.getTime() === last.getTime()
    ? `Shot at ${fmt(first)}`
    : `Shot ${fmt(first)} – ${fmt(last)}`;
}
