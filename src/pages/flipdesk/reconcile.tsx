import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers, Upload, Loader2, ImageOff, Clock, HelpCircle } from "lucide-react";
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
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";
import { readCaptureTime } from "@/lib/exif";
import {
  clusterByTimeGap,
  DEFAULT_GAP_SECONDS,
  type ClusterablePhoto,
} from "@/lib/reconcile-cluster";
import { cn } from "@/lib/utils";

// A photo as held in the reconcile UI before it's committed to inventory.
interface DumpPhoto extends ClusterablePhoto {
  file: File;
  previewUrl: string;
}

const ACCEPT = "image/*";

export function FlipdeskReconcilePage() {
  const { workspaceOwnerId, can } = useWorkspace();
  const [photos, setPhotos] = useState<DumpPhoto[]>([]);
  const [gapSeconds, setGapSeconds] = useState(DEFAULT_GAP_SECONDS);
  const [ingesting, setIngesting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Release object URLs when the page unmounts to avoid leaking blob memory.
  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // Intentionally only on unmount — per-photo cleanup happens on reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cluster live whenever the photo set or threshold changes (US-282).
  const { clusters, needsSorting } = useMemo(
    () => clusterByTimeGap(photos, gapSeconds),
    [photos, gapSeconds],
  );

  // Lazily create the reconcile session row on first ingest, then reuse it.
  const ensureSession = useCallback(
    async (existing: string | null): Promise<string | null> => {
      if (existing) return existing;
      if (!workspaceOwnerId) return null;
      const { data, error } = await supabase
        .from("flipdesk_reconcile_sessions")
        .insert({ user_id: workspaceOwnerId } as never)
        .select("id")
        .single();
      if (error) {
        // Don't block clustering if persistence fails — it's recoverable.
        toast.error("Could not start a reconcile session; grouping still works.");
        return null;
      }
      const id = (data as { id: string }).id;
      setSessionId(id);
      return id;
    },
    [workspaceOwnerId],
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
      const activeSession = await ensureSession(sessionId);
      try {
        // Read EXIF capture time from the ORIGINAL file before any
        // compression strips it. Awaiting per-file yields to the event loop so
        // a 100+ photo drop never freezes the UI; we flush in batches so the
        // tray fills progressively.
        const batch: DumpPhoto[] = [];
        let added = 0;
        for (const file of files) {
          const capturedAt = await readCaptureTime(file);
          batch.push({
            id: crypto.randomUUID(),
            file,
            previewUrl: URL.createObjectURL(file),
            capturedAt,
          });
          if (batch.length >= 12) {
            const flush = batch.splice(0);
            setPhotos((prev) => [...prev, ...flush]);
            added += flush.length;
          }
        }
        if (batch.length > 0) {
          setPhotos((prev) => [...prev, ...batch]);
          added += batch.length;
        }

        // Keep the session's running photo_count in sync (best-effort).
        if (activeSession) {
          await supabase
            .from("flipdesk_reconcile_sessions")
            .update({ photo_count: photos.length + added } as never)
            .eq("id", activeSession);
        }
      } finally {
        setIngesting(false);
      }
    },
    [can, ensureSession, sessionId, photos.length],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void ingest(e.dataTransfer.files);
  }

  function reset() {
    for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    setPhotos([]);
    setSessionId(null);
  }

  const timedCount = photos.length - needsSorting.length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Layers className="h-6 w-6 text-primary" />
            Photo Dump Reconcile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop a whole haul of photos at once. We group them into proposed items
            by when each photo was taken — adjust the time gap to re-group live.
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
            onDrop={onDrop}
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
          {/* Running counts + threshold slider */}
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
                    onChange={(e) => setGapSeconds(Number(e.target.value))}
                    className="h-2 w-44 cursor-pointer accent-primary"
                  />
                </div>
              </div>
              <CardDescription>
                A gap of {gapSeconds}s or more between consecutive shots starts a new
                item group. {timedCount} of {photos.length} photos have a capture time.
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Proposed clusters */}
          <div className="space-y-4">
            {clusters.map((cluster, i) => (
              <Card key={cluster[0]?.id ?? i}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Item {i + 1}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {cluster.length} photo{cluster.length === 1 ? "" : "s"}
                    </span>
                  </CardTitle>
                  <CardDescription>{formatRange(cluster)}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ThumbGrid photos={cluster} />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Needs-sorting bucket — photos with no usable capture time */}
          {needsSorting.length > 0 && (
            <Card className="border-amber-300/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HelpCircle className="h-4 w-4 text-amber-500" />
                  Needs sorting
                  <span className="font-normal text-muted-foreground">
                    · {needsSorting.length} photo{needsSorting.length === 1 ? "" : "s"}
                  </span>
                </CardTitle>
                <CardDescription>
                  No capture time was found in these photos, so they weren&apos;t auto-grouped.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ThumbGrid photos={needsSorting} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ThumbGrid({ photos }: { photos: DumpPhoto[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
      {photos.map((p) => (
        <div
          key={p.id}
          className="relative aspect-square overflow-hidden rounded-md border bg-muted"
        >
          {p.previewUrl ? (
            <img
              src={p.previewUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageOff className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
          )}
        </div>
      ))}
    </div>
  );
}

function formatRange(cluster: DumpPhoto[]): string {
  const first = cluster[0]?.capturedAt;
  const last = cluster[cluster.length - 1]?.capturedAt;
  if (!first || !last) return "Capture time unknown";
  const fmt = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return first.getTime() === last.getTime()
    ? `Shot at ${fmt(first)}`
    : `Shot ${fmt(first)} – ${fmt(last)}`;
}
