import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Wand2,
  Save,
  Loader2,
  Plus,
  Award,
  Star,
  GripVertical,
  ImageOff,
  Rocket,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  DESCRIPTION_TEMPLATES,
  interpolateDescription,
  suggestTitle,
  titleKeywords,
  templateGroupFor,
} from "@/lib/listing-templates";
import { compositeGradeBadge } from "@/lib/grade-badge";
import { resolveStatus, factsOf } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import { EbayCategoryPicker } from "@/components/flipdesk/ebay-category-picker";
import { EbayCompsPanel } from "@/components/flipdesk/ebay-comps-panel";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { useEbayConnection } from "@/hooks/use-ebay";
import type {
  ItemFullRow,
  ItemPhotoRow,
  ListingInsert,
  ListingRow,
} from "@/types/database";

const TITLE_MAX = 80;

export function FlipdeskComposerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [order, setOrder] = useState<ItemPhotoRow[]>([]);
  const [primaryPhotoId, setPrimaryPhotoId] = useState<string | null>(null);
  const [badgeEnabled, setBadgeEnabled] = useState(false);
  const [badgeBusy, setBadgeBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialised, setInitialised] = useState(false);
  // Lifted from the category picker so the comps panel reacts to a pick
  // before the user commits via "Save eBay specifics".
  const [livePickedCategoryId, setLivePickedCategoryId] = useState<
    string | null
  >(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const { data: ebayConnection } = useEbayConnection();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const item = useMemo(
    () => items.find((it) => it.id === id) ?? null,
    [items, id],
  );

  const { data: photos = [] } = useQuery({
    queryKey: ["item_photos", id],
    enabled: !!id,
    queryFn: async (): Promise<ItemPhotoRow[]> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("*")
        .eq("inventory_item_id", id!)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ItemPhotoRow[];
    },
  });

  // The most-recent listing row, when one exists — seeds the saved picks.
  const { data: listing = null } = useQuery({
    queryKey: ["listing", item?.listing_id],
    enabled: !!item?.listing_id,
    queryFn: async (): Promise<ListingRow | null> => {
      const { data, error } = await supabase
        .from("listings")
        .select("*")
        .eq("id", item!.listing_id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ListingRow | null;
    },
  });

  // eBay taxonomy mapping lives on inventory_items (added in 00030), which
  // isn't exposed through the items_full view. Fetch it on the side so the
  // composer can render the eBay category picker.
  const { data: ebayMapping = null } = useQuery({
    queryKey: ["inventory_item_ebay", id],
    enabled: !!id,
    queryFn: async (): Promise<{
      ebay_category_id: string | null;
      ebay_aspects: Record<string, string[]> | null;
    } | null> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("ebay_category_id, ebay_aspects")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as {
        ebay_category_id: string | null;
        ebay_aspects: Record<string, string[]> | null;
      } | null;
    },
  });

  // Keep the local drag order in sync with fetched photos.
  useEffect(() => {
    setOrder(photos);
  }, [photos]);

  // Seed editable fields once the item, photos, and listing have settled.
  useEffect(() => {
    if (initialised || !item) return;
    if (item.listing_id && !listing) return; // wait for the listing fetch
    setTitle(
      (listing?.listing_title ?? item.item_title ?? "").slice(0, TITLE_MAX),
    );
    setDescription(listing?.listing_description ?? "");
    setBadgeEnabled(listing?.badge_enabled ?? false);
    const seededPrimary =
      listing?.primary_photo_id &&
      photos.some((p) => p.id === listing.primary_photo_id)
        ? listing.primary_photo_id
        : (photos[0]?.id ?? null);
    setPrimaryPhotoId(seededPrimary);
    setInitialised(true);
  }, [initialised, item, listing, photos]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const keywords = item ? titleKeywords(item) : [];
  const group = item ? templateGroupFor(item) : "generic";
  const primaryPhoto =
    order.find((p) => p.id === primaryPhotoId) ?? order[0] ?? null;
  const resolvedDescription = item
    ? interpolateDescription(description, item)
    : description;

  const specifics = useMemo(() => {
    if (!item) return [] as { label: string; value: string }[];
    const rows: { label: string; value: string | null }[] = [
      { label: "Brand", value: item.brand },
      { label: "Style", value: item.style },
      { label: "Size", value: item.size },
      { label: "Category", value: item.category },
      {
        label: "Condition",
        value: item.grade_label ?? "Pre-owned",
      },
    ];
    if (item.grade_value != null) {
      rows.push({
        label: "GradeThread Grade",
        value: `${item.grade_value.toFixed(1)} / 10`,
      });
    }
    return rows.filter(
      (r): r is { label: string; value: string } =>
        !!r.value && r.value.trim() !== "",
    );
  }, [item]);

  function applyTemplate() {
    if (!item) return;
    setDescription(interpolateDescription(DESCRIPTION_TEMPLATES[group], item));
    toast.info(`Applied the ${group} template.`);
  }

  function appendKeyword(kw: string) {
    const next = title.trim() ? `${title.trim()} ${kw}` : kw;
    setTitle(next.slice(0, TITLE_MAX));
  }

  async function persistOrder(next: ItemPhotoRow[]) {
    try {
      await Promise.all(
        next.map((p, i) =>
          supabase
            .from("item_photos")
            .update({ sort_order: i } as never)
            .eq("id", p.id),
        ),
      );
      await qc.invalidateQueries({ queryKey: ["item_photos", id] });
    } catch {
      toast.error("Failed to save the new photo order.");
      await qc.invalidateQueries({ queryKey: ["item_photos", id] });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((p) => p.id === active.id);
    const newIndex = order.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next); // optimistic
    void persistOrder(next);
  }

  // Composite the grade badge onto the primary photo and store it as a
  // separate, not-yet-uploaded item_photos row, then make it the primary.
  async function toggleBadge(next: boolean) {
    if (!next) {
      setBadgeEnabled(false);
      return;
    }
    if (!item || !user || item.grade_value == null || !primaryPhoto) return;
    setBadgeBusy(true);
    try {
      const blob = await compositeGradeBadge(
        primaryPhoto.photo_url,
        item.grade_value,
        item.grade_label,
      );
      const path = `${user.id}/${item.id}/badged_${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("item-photos")
        .upload(path, blob, { upsert: false, contentType: "image/jpeg" });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage
        .from("item-photos")
        .getPublicUrl(path);

      const { data: inserted, error: insErr } = await supabase
        .from("item_photos")
        .insert({
          inventory_item_id: item.id,
          photo_url: pub.publicUrl,
          storage_path: path,
          photo_type: primaryPhoto.photo_type,
          sort_order: order.length,
          ebay_uploaded: false,
        } as never)
        .select()
        .single();
      if (insErr) throw insErr;

      const newRow = inserted as ItemPhotoRow;
      await qc.invalidateQueries({ queryKey: ["item_photos", id] });
      setPrimaryPhotoId(newRow.id);
      setBadgeEnabled(true);
      toast.success("Badged photo added — set as the primary image.");
    } catch (err) {
      toast.error(
        `Couldn't create the badged photo: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBadgeBusy(false);
    }
  }

  async function saveDraft() {
    if (!item) return;
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSaving(true);
    try {
      const payload: ListingInsert = {
        inventory_item_id: item.id,
        platform: "ebay",
        listing_status: "draft",
        listing_price: item.target_price ?? item.list_price ?? 0,
        listing_title: title.trim(),
        listing_description: description.trim() || null,
        is_active: false,
        primary_photo_id: primaryPhotoId,
        badge_enabled: badgeEnabled,
      };

      if (item.listing_id && item.listing_status === "draft") {
        const { error } = await supabase
          .from("listings")
          .update(payload as never)
          .eq("id", item.listing_id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("listings")
          .insert(payload as never);
        if (error) throw error;
      }

      // Forward-only: never regress a listed/sold item back to "drafted".
      const resolvedStatus = resolveStatus(item.status, "drafted", {
        ...factsOf(item),
        hasDraftListing: true,
      });
      const { error: sErr } = await supabase
        .from("inventory_items")
        .update({ status: resolvedStatus } as never)
        .eq("id", item.id);
      if (sErr) throw sErr;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["listing", item.listing_id] });
      toast.success("Draft saved.");
      // Return to the item canvas — the next-action CTA there will offer
      // "Mark listed" so the workflow continues in one place.
      navigate(`/dashboard/flipdesk/items/${item.id}`);
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Loading item…
      </div>
    );
  }

  if (!item) {
    return (
      <div className="space-y-3 py-12 text-center">
        <div className="text-sm text-muted-foreground">Item not found.</div>
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  const titleLen = title.length;
  const previewPrice = item.target_price ?? item.list_price ?? null;
  const showBadgeOverlay = badgeEnabled && item.grade_value != null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Listing composer
          </h1>
          <p className="text-sm text-muted-foreground">
            Build, preview, and pick photo variants for "{item.item_title}".
          </p>
        </div>
      </div>

      {item.grade_value != null && (
        <div className="flex items-center gap-2 rounded-md border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
          <Award className="h-4 w-4 text-brand-navy" />
          <span>
            Graded {item.grade_value.toFixed(1)}/10
            {item.grade_label ? ` · ${item.grade_label}` : ""}. The grade and
            certificate link are embedded when you apply a template.
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Editor column ───────────────────────────────────────── */}
        <div className="space-y-6">
          {/* Title */}
          <Card>
            <CardHeader>
              <CardTitle>Title</CardTitle>
              <CardDescription>
                eBay caps titles at {TITLE_MAX} characters. Lead with the brand.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Input
                  value={title}
                  maxLength={TITLE_MAX}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Brand Item Size Category"
                />
                <span
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums",
                    titleLen >= TITLE_MAX
                      ? "font-semibold text-destructive"
                      : titleLen > 70
                        ? "text-amber-600"
                        : "text-muted-foreground",
                  )}
                >
                  {titleLen}/{TITLE_MAX}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTitle(suggestTitle(item))}
                >
                  <Wand2 className="mr-2 h-3 w-3" />
                  Suggest title
                </Button>
                {keywords.map((kw) => (
                  <button
                    key={kw}
                    type="button"
                    onClick={() => appendKeyword(kw)}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    <Plus className="h-3 w-3" />
                    {kw}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* eBay category + item specifics */}
          <EbayCategoryPicker
            itemId={item.id}
            initialCategoryId={ebayMapping?.ebay_category_id ?? null}
            initialAspects={ebayMapping?.ebay_aspects ?? null}
            seedQuery={item.item_title ?? ""}
            onCategoryChange={setLivePickedCategoryId}
          />

          {/* Live comps + price recommendation */}
          <EbayCompsPanel
            itemId={item.id}
            categoryId={
              livePickedCategoryId ?? ebayMapping?.ebay_category_id ?? null
            }
            brand={item.brand ?? null}
            size={item.size ?? null}
            q={item.item_title ?? ""}
          />

          {/* Photos */}
          <Card>
            <CardHeader>
              <CardTitle>Photos</CardTitle>
              <CardDescription>
                Drag to reorder. Click the star to choose the primary image.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {order.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  No photos yet — add some from the item's Photos tab first.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={order.map((p) => p.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {order.map((photo) => (
                        <ComposerPhoto
                          key={photo.id}
                          photo={photo}
                          isPrimary={photo.id === primaryPhoto?.id}
                          onPickPrimary={() => setPrimaryPhotoId(photo.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}

              <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                <div className="space-y-0.5">
                  <Label
                    htmlFor="badge-toggle"
                    className="text-sm font-medium"
                  >
                    Add grade badge to primary photo
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {item.grade_value == null
                      ? "Grade this item first to enable the badge."
                      : "Composites a GradeThread badge into the corner and saves it as a new photo."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {badgeBusy && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  <Switch
                    id="badge-toggle"
                    checked={badgeEnabled}
                    disabled={
                      badgeBusy ||
                      item.grade_value == null ||
                      order.length === 0
                    }
                    onCheckedChange={(v) => void toggleBadge(v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Description */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Description</CardTitle>
                  <CardDescription>
                    Apply the{" "}
                    <Badge variant="outline" className="capitalize">
                      {group}
                    </Badge>{" "}
                    template, then edit freely.
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={applyTemplate}>
                  <Wand2 className="mr-2 h-3 w-3" />
                  Apply template
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={14}
                placeholder="Apply the template above, or write your own."
                className="font-mono text-xs"
              />
            </CardContent>
          </Card>
        </div>

        {/* ── Preview column ──────────────────────────────────────── */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Listing preview
                <Badge variant="secondary" className="font-normal">
                  eBay
                </Badge>
              </CardTitle>
              <CardDescription>
                How the drafted listing will render to buyers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Primary photo */}
              <div className="relative aspect-square overflow-hidden rounded-md border bg-muted/40">
                {primaryPhoto ? (
                  <img
                    src={primaryPhoto.photo_url}
                    alt={title || item.item_title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                    <ImageOff className="h-6 w-6" />
                    <span className="text-xs">No photo selected</span>
                  </div>
                )}
                {showBadgeOverlay && primaryPhoto && (
                  <div className="absolute bottom-2 right-2 flex overflow-hidden rounded-md bg-brand-navy text-white shadow-lg">
                    <div className="w-1.5 bg-brand-red" />
                    <div className="px-2.5 py-1.5 leading-tight">
                      <div className="text-[8px] font-bold tracking-wider">
                        GRADETHREAD VERIFIED
                      </div>
                      <div className="text-base font-bold">
                        {item.grade_value!.toFixed(1)} / 10
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Thumbnail strip */}
              {order.length > 0 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {order.map((photo) => (
                    <img
                      key={photo.id}
                      src={photo.photo_url}
                      alt=""
                      className={cn(
                        "h-12 w-12 flex-shrink-0 rounded border object-cover",
                        photo.id === primaryPhoto?.id &&
                          "ring-2 ring-brand-navy",
                      )}
                    />
                  ))}
                </div>
              )}

              {/* Title + price */}
              <div className="space-y-1">
                <h2 className="text-base font-semibold leading-snug">
                  {title || (
                    <span className="text-muted-foreground">
                      Untitled listing
                    </span>
                  )}
                </h2>
                <div className="text-xl font-bold text-brand-navy">
                  {previewPrice != null
                    ? `$${previewPrice.toFixed(2)}`
                    : "Price not set"}
                </div>
              </div>

              {/* Item specifics */}
              {specifics.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Item specifics
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
                    {specifics.map((s) => (
                      <div key={s.label} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">{s.label}</dt>
                        <dd className="text-right font-medium">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {/* Description */}
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Description
                </div>
                {resolvedDescription.trim() ? (
                  <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
                    {resolvedDescription}
                  </p>
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    Apply a template or write a description to preview it here.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(-1)} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={saveDraft}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save draft
        </Button>
        <Button
          onClick={() => setPublishOpen(true)}
          disabled={!ebayConnection || saving}
          title={
            !ebayConnection
              ? "Connect eBay first on the Marketplaces page."
              : undefined
          }
        >
          <Rocket className="mr-2 h-4 w-4" />
          Publish to eBay
        </Button>
      </div>

      <PublishToEbayDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        itemId={item.id}
      />
    </div>
  );
}

function ComposerPhoto({
  photo,
  isPrimary,
  onPickPrimary,
}: {
  photo: ItemPhotoRow;
  isPrimary: boolean;
  onPickPrimary: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: photo.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(
        "relative aspect-square overflow-hidden rounded-md border bg-muted/40",
        isPrimary && "ring-2 ring-brand-navy",
      )}
    >
      <img
        src={photo.photo_url}
        alt=""
        className="h-full w-full object-cover"
      />
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1 cursor-grab rounded bg-background/80 p-1 text-muted-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onPickPrimary}
        aria-label={isPrimary ? "Primary photo" : "Set as primary photo"}
        title={isPrimary ? "Primary photo" : "Set as primary photo"}
        className={cn(
          "absolute right-1 top-1 rounded bg-background/80 p-1",
          isPrimary
            ? "text-amber-500"
            : "text-muted-foreground hover:text-amber-500",
        )}
      >
        <Star
          className={cn("h-3.5 w-3.5", isPrimary && "fill-current")}
        />
      </button>
      {isPrimary && (
        <span className="absolute bottom-1 left-1 rounded bg-brand-navy px-1.5 py-0.5 text-[9px] font-semibold text-white">
          Primary
        </span>
      )}
    </div>
  );
}
