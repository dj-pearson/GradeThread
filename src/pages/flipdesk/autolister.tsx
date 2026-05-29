import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  Loader2,
  Sparkles,
  Trash2,
  Plus,
  Star,
  X,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { compressImage } from "@/lib/image-utils";
import { useStartAutolisterBatch } from "@/hooks/use-autolister";
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
}

interface Group {
  id: string;
  name: string;
  photoIds: string[];
  coverId: string;
}

function extForBlobType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

export function FlipdeskAutolisterPage() {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const ownerId = workspaceOwnerId ?? user?.id ?? null;
  const navigate = useNavigate();
  const startBatch = useStartAutolisterBatch();

  const sessionId = useRef(crypto.randomUUID());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [staged, setStaged] = useState<StagedPhoto[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);

  const stagedById = useMemo(
    () => new Map(staged.map((p) => [p.id, p])),
    [staged],
  );
  const groupedIds = useMemo(
    () => new Set(groups.flatMap((g) => g.photoIds)),
    [groups],
  );
  const ungrouped = staged.filter((p) => !groupedIds.has(p.id));

  async function handleFiles(files: FileList | null) {
    if (!files || !ownerId) return;
    setUploading((n) => n + files.length);
    const added: StagedPhoto[] = [];
    for (const file of Array.from(files)) {
      try {
        if (!file.type.startsWith("image/")) continue;
        const id = crypto.randomUUID();
        let body: Blob = file;
        let bodyType = file.type || "image/webp";
        let width: number | null = null;
        let height: number | null = null;
        let thumbBlob: Blob | null = null;
        let thumbType = "image/webp";
        try {
          const main = await compressImage(file, 2400, 0.85);
          body = main.blob;
          bodyType = main.blob.type || "image/webp";
          width = main.width;
          height = main.height;
          const thumb = await compressImage(file, 320, 0.7);
          thumbBlob = thumb.blob;
          thumbType = thumb.blob.type || "image/webp";
        } catch (compErr) {
          console.warn("[autolister] compress failed, using original:", compErr);
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
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  function updateGroup(id: string, patch: Partial<Group>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
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

        // Cover photo first (front), rest detail, in display order.
        const ordered = [
          ...photos.filter((p) => p.id === g.coverId),
          ...photos.filter((p) => p.id !== g.coverId),
        ];

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
          photo_type: idx === 0 ? "front" : "detail",
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

      const res = await startBatch.mutateAsync({ item_ids: itemIds });
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
          disabled={busy || groups.length === 0 || uploading > 0}
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

      {/* Upload */}
      <Card className="p-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-10 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          {uploading > 0 ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : (
            <Upload className="h-7 w-7" />
          )}
          <span className="text-sm font-medium">
            {uploading > 0
              ? `Uploading ${uploading}…`
              : "Click to add photos (or pick a whole folder of images)"}
          </span>
          <span className="text-xs">
            Resized &amp; compressed in your browser before upload.
          </span>
        </button>
      </Card>

      {/* Ungrouped staging area */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Ungrouped photos {ungrouped.length > 0 && `(${ungrouped.length})`}
          </h2>
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
        {ungrouped.length === 0 ? (
          <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
            {staged.length === 0
              ? "No photos yet — upload some above."
              : "All photos are grouped. Generate when ready."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {ungrouped.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleSelect(p.id)}
                className={cn(
                  "relative aspect-square overflow-hidden rounded-md border-2",
                  selected.has(p.id)
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-transparent hover:border-muted-foreground/40",
                )}
              >
                <img
                  src={p.thumbnailUrl ?? p.url}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                {selected.has(p.id) && (
                  <span className="absolute right-1 top-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Groups */}
      {groups.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Listings to generate ({groups.length})
          </h2>
          {groups.map((g) => (
            <Card key={g.id} className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <Input
                  value={g.name}
                  onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                  className="h-8 max-w-xs"
                  placeholder="Item name"
                />
                <Badge variant="secondary">{g.photoIds.length} photos</Badge>
                <div className="ml-auto">
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
                        onClick={() => updateGroup(g.id, { coverId: pid })}
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
