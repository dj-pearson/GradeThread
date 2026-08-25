import { useId, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Save,
  Loader2,
  ArrowLeft,
  Boxes,
  Sparkles,
  Camera,
  WifiOff,
  CloudUpload,
  ScanBarcode,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useSources } from "@/hooks/use-sources";
import { BulkIntake } from "@/components/flipdesk/bulk-intake";
import { SnapCatalog } from "@/components/flipdesk/snap-catalog";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { useOfflineIntakeSync } from "@/hooks/use-offline-intake";
import { enqueueIntake } from "@/lib/offline-queue";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiExtract,
  type AiExtractResponse,
} from "@/hooks/use-ai-extract";
import { useProductLookup } from "@/hooks/use-product-lookup";
import { BarcodeScannerDialog } from "@/components/flipdesk/barcode-scanner-dialog";
import { GradeRoiHint } from "@/components/flipdesk/grade-roi-hint";
import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import {
  IntakePhotoStager,
  type StagedPhoto,
} from "@/components/flipdesk/intake-photo-stager";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { uploadItemPhoto } from "@/lib/item-photo-upload";
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  INTAKE_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import type {
  InventoryItemInsert,
  ItemStatus,
  ItemCategory,
  AiFieldSource,
} from "@/types/database";
import { deriveGarmentDefaults } from "@/lib/garment-mapping";
import { todayLocalDate } from "@/lib/local-date";
import { garmentDescriptorFor } from "@/lib/measurement-templates";

// Form fields the AI extractor can fill.
const AI_FILLABLE_FIELDS = [
  "title",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  "condition_notes",
] as const;

const AI_FIELD_LABELS: Record<string, string> = {
  item_category: "Category",
  condition_notes: "Internal notes",
};

interface FormState {
  title: string;
  sku: string;
  container: string;
  brand: string;
  style: string;
  size: string;
  color: string;
  material: string;
  item_category: ItemCategory | "";
  source_id: string;
  source_new: string; // new source name (used when source_id === "__new")
  sourced_by: string;
  purchase_date: string;
  purchase_price: string;
  description: string;
  condition_notes: string;
  status: ItemStatus;
}

const INITIAL: FormState = {
  title: "",
  sku: "",
  container: "",
  brand: "",
  style: "",
  size: "",
  color: "",
  material: "",
  item_category: "",
  source_id: "",
  source_new: "",
  sourced_by: "",
  purchase_date: todayLocalDate(),
  purchase_price: "",
  description: "",
  condition_notes: "",
  status: "cataloged",
};

function priceOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

export function FlipdeskIntakePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  const { data: sources = [] } = useSources();
  const [params] = useSearchParams();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [saving, setSaving] = useState(false);
  // US-2546 AC2: photos staged in memory until the item row exists.
  const [stagedPhotos, setStagedPhotos] = useState<StagedPhoto[]>([]);
  // US-2546 AC4: "measured" is a pipeline status with its own page, so intake
  // may as well capture the numbers when the garment is already on the table.
  const [measurements, setMeasurements] = useState<
    Record<string, number | string>
  >({});
  const offline = useOfflineIntakeSync();

  // AI Fill state
  const aiExtract = useAiExtract();
  const [aiResult, setAiResult] = useState<AiExtractResponse | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiFields, setAiFields] = useState<Set<string>>(new Set());
  const [aiMeta, setAiMeta] = useState<
    Record<string, { source: string; confidence: number }>
  >({});

  // US-598: barcode/UPC scan-to-autofill.
  const productLookup = useProductLookup();
  const [scannerOpen, setScannerOpen] = useState(false);

  // US-2546 AC3: Cancel and Back used to abandon a filled form in silence,
  // while iOS has offered draft resume and an explicit discard confirmation
  // since DetailsIntakeView. `dirty` is deliberately narrow: it is true only
  // when there is something a seller would be upset to lose, so the dialog
  // never fires on an untouched form. Staged photos count double - they cannot
  // be recovered from anywhere.
  const dirty =
    !saving &&
    (stagedPhotos.length > 0 ||
      Object.entries(form).some(
        ([k, v]) => v !== INITIAL[k as keyof FormState],
      ) ||
      Object.keys(measurements).length > 0);
  const guard = useNavigationGuard(dirty);

  // Alternate intake modes are separate workspaces.
  if (params.get("mode") === "bulk") return <BulkIntake />;
  if (params.get("mode") === "snap") return <SnapCatalog />;

  function patch<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    // A manual edit clears the AI marker on that field.
    setAiFields((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  async function handleAiFill() {
    const text = [form.title, form.description, form.condition_notes]
      .filter((s) => s.trim())
      .join("\n");
    if (!text.trim()) {
      toast.error("Add a title, description, or notes for the AI to read.");
      return;
    }
    const known: Record<string, unknown> = {};
    for (const k of [
      "brand",
      "style",
      "size",
      "color",
      "material",
      "item_category",
    ] as const) {
      if (form[k] && String(form[k]).trim()) known[k] = form[k];
    }
    try {
      const result = await aiExtract.mutateAsync({ text, known_fields: known });
      setAiResult(result);
      setAiPanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    }
  }

  // US-598: a scanned code resolves to product data we autofill into empty
  // fields. The code is always saved as the SKU, match or not.
  async function handleScanDetected(code: string) {
    setScannerOpen(false);
    const before = form;
    patch("sku", code);
    try {
      const r = await productLookup.mutateAsync({ code });
      setForm((f) => ({
        ...f,
        sku: r.sku || code,
        brand: r.brand && !f.brand.trim() ? r.brand : f.brand,
        style: r.style && !f.style.trim() ? r.style : f.style,
        title: r.productTitle && !f.title.trim() ? r.productTitle : f.title,
      }));
      const filled: string[] = [];
      if (r.brand && !before.brand.trim()) filled.push("brand");
      if (r.style && !before.style.trim()) filled.push("style");
      if (r.productTitle && !before.title.trim()) filled.push("title");
      if (r.found && filled.length > 0) {
        toast.success(`Autofilled ${filled.join(", ")} from the scan.`);
      } else if (r.found) {
        toast.success("Matched — code saved to SKU.");
      } else {
        toast.message("No product match", {
          description: "Saved the code as the SKU — fill the rest in manually.",
        });
      }
    } catch {
      /* hook shows the error toast; the SKU is already set */
    }
  }

  function applyAiFields(accepted: AcceptedField[]) {
    setForm((f) => {
      const next = { ...f } as unknown as Record<string, unknown>;
      for (const a of accepted) {
        if ((AI_FILLABLE_FIELDS as readonly string[]).includes(a.field)) {
          next[a.field] = a.value;
        }
      }
      return next as unknown as FormState;
    });
    setAiFields((prev) => {
      const next = new Set(prev);
      for (const a of accepted) next.add(a.field);
      return next;
    });
    setAiMeta((prev) => {
      const next = { ...prev };
      for (const a of accepted) {
        next[a.field] = { source: a.source, confidence: a.confidence };
      }
      return next;
    });
    if (accepted.length > 0) {
      toast.success(
        `Applied ${accepted.length} AI suggestion${
          accepted.length === 1 ? "" : "s"
        }.`
      );
    }
  }

  const aiCurrentValues: Record<string, string> = {
    title: form.title,
    brand: form.brand,
    style: form.style,
    size: form.size,
    color: form.color,
    material: form.material,
    item_category: form.item_category,
    condition_notes: form.condition_notes,
  };

  async function save(goBackToList: boolean) {
    if (!user || !workspaceOwnerId) {
      toast.error("You must be signed in.");
      return;
    }
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to add inventory in this workspace.");
      return;
    }
    if (!form.title.trim()) {
      toast.error("Title is required.");
      return;
    }
    if (form.source_id === "__new" && !form.source_new.trim()) {
      toast.error("Enter a name for the new source.");
      return;
    }
    // Creating a brand-new source needs the network (a server-side RPC).
    if (!navigator.onLine && form.source_id === "__new") {
      toast.error(
        "You're offline — pick an existing source, or reconnect to add a new one.",
      );
      return;
    }

    setSaving(true);
    try {
      // Resolve source: existing id, new (via RPC), or none.
      let sourceId: string | null = null;
      if (form.source_id === "__new" && form.source_new.trim()) {
        const supabaseAny = supabase as unknown as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: string | null; error: Error | null }>;
        };
        const { data, error } = await supabaseAny.rpc(
          "get_or_create_source",
          {
            p_user_id: workspaceOwnerId,
            p_name: form.source_new.trim(),
            p_source_type: "other",
          },
        );
        if (error) throw error;
        sourceId = data;
      } else if (form.source_id && form.source_id !== "__none") {
        sourceId = form.source_id;
      }

      // Record which fields were AI-filled (and still are) for provenance.
      const aiFieldSources: Record<string, AiFieldSource> = {};
      for (const field of aiFields) {
        const meta = aiMeta[field];
        aiFieldSources[field] = {
          source: meta?.source ?? "text",
          confidence: meta?.confidence ?? 0,
          accepted: true,
        };
      }
      const hasAiFields = Object.keys(aiFieldSources).length > 0;

      // US-1423: grading requires garment_type + garment_category, which intake
      // never asked for — so every clothing item had to be re-classified in
      // ItemCanvas before it could be graded. Derive them here (preferring any
      // garment values the AI extractor returned) so catalog captures them once.
      const itemCategory = form.item_category === "" ? null : form.item_category;
      const garment = deriveGarmentDefaults(itemCategory, {
        garment_type: aiResult?.suggestions?.garment_type?.value ?? null,
        garment_category: aiResult?.suggestions?.garment_category?.value ?? null,
      });

      const insert: InventoryItemInsert = {
        user_id: workspaceOwnerId,
        title: form.title.trim(),
        sku: trimOrNull(form.sku),
        container: trimOrNull(form.container),
        brand: trimOrNull(form.brand),
        style: trimOrNull(form.style),
        size: trimOrNull(form.size),
        color: trimOrNull(form.color),
        material: trimOrNull(form.material),
        item_category: itemCategory,
        garment_type: garment.garment_type,
        garment_category: garment.garment_category,
        source_id: sourceId,
        sourced_by: trimOrNull(form.sourced_by),
        acquired_date: form.purchase_date || null,
        acquired_price: priceOrNull(form.purchase_price),
        description: trimOrNull(form.description),
        condition_notes: trimOrNull(form.condition_notes),
        status: form.status,
        // US-2546 AC4: captured at intake rather than on a later visit to prep.
        measurements:
          Object.keys(measurements).length > 0 ? measurements : undefined,
        ai_field_sources: hasAiFields ? aiFieldSources : undefined,
        ai_enriched_at: hasAiFields ? new Date().toISOString() : undefined,
      };

      // Offline: persist to the IndexedDB queue and flush on reconnect.
      if (!navigator.onLine) {
        await enqueueIntake(insert);
        await offline.refresh();
        toast.success(
          `Saved "${form.title.trim()}" offline — it'll sync when you reconnect.`,
        );
        setForm({
          ...INITIAL,
          source_id: form.source_id === "__new" ? "" : form.source_id,
          container: form.container,
          sourced_by: form.sourced_by,
          purchase_date: form.purchase_date,
        });
        setAiFields(new Set());
        setAiMeta({});
        setAiResult(null);
        setStagedPhotos([]);
        setMeasurements({});
        return;
      }

      const { data: row, error } = await supabase
        .from("inventory_items")
        .insert(insert as never)
        .select("id")
        .single();
      if (error) throw error;
      const newId = (row as { id: string } | null)?.id;

      // US-2546 AC2: the staged photos go up through the SAME core the item
      // page uses (src/lib/item-photo-upload.ts). A failure here must not read
      // as a failed save — the item exists, so say what happened and let the
      // seller finish on the item page.
      if (newId && stagedPhotos.length > 0) {
        let uploaded = 0;
        for (const [i, staged] of stagedPhotos.entries()) {
          try {
            await uploadItemPhoto({
              file: staged.file,
              itemId: newId,
              ownerFolder: workspaceOwnerId,
              photoType: staged.photoType,
              photoRole: staged.photoRole ?? null,
              sortOrder: i,
            });
            uploaded++;
          } catch (photoErr) {
            if (import.meta.env.DEV) {
              console.warn("[intake] photo upload failed:", photoErr);
            }
          }
        }
        await qc.invalidateQueries({ queryKey: ["item_photos", newId] });
        if (uploaded < stagedPhotos.length) {
          toast.warning(
            `Saved the item, but ${stagedPhotos.length - uploaded} photo${
              stagedPhotos.length - uploaded === 1 ? "" : "s"
            } didn't upload. Add them from the item page.`,
          );
        }
      }

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sources"] });

      toast.success(`Added "${form.title.trim()}".`);

      if (goBackToList) {
        navigate(
          newId
            ? `/dashboard/flipdesk/items?focus=${newId}`
            : "/dashboard/flipdesk/items",
        );
      } else {
        // Reset to add another, keeping source + container + sourced_by
        // (most common scenario: cataloging a batch from the same trip)
        setForm({
          ...INITIAL,
          source_id: form.source_id === "__new" ? "" : form.source_id,
          container: form.container,
          sourced_by: form.sourced_by,
          purchase_date: form.purchase_date,
        });
        setAiFields(new Set());
        setAiMeta({});
        setAiResult(null);
        setStagedPhotos([]);
        setMeasurements({});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/dashboard/flipdesk/items")}
            aria-label="Back to items"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add item</h1>
            <p className="text-sm text-muted-foreground">
              Quick intake form. Save & Add another to catalog a batch from the
              same source.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleAiFill}
            disabled={aiExtract.isPending}
          >
            {aiExtract.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            AI Fill
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/intake?mode=snap">
              <Camera className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Snap &amp; Catalog</span>
              <span className="sm:hidden">Snap</span>
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/intake?mode=bulk">
              <Boxes className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Bulk haul mode</span>
              <span className="sm:hidden">Bulk</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* PWA install prompt — surfaces once when the app is installable. */}
      <PwaInstallBanner />

      {!offline.online && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <WifiOff className="h-4 w-4 flex-shrink-0" />
          You're offline. New items are saved to a queue and sync
          automatically when you reconnect.
        </div>
      )}
      {offline.pending > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
          <CloudUpload className="h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
          {offline.pending} item{offline.pending === 1 ? "" : "s"} queued
          offline{offline.online ? " — syncing…" : "."}
        </div>
      )}

      {/* Auto-suggest banner — nudges AI Fill once there's text to read. */}
      {form.description.trim() && aiFields.size === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            Let AI pull brand, size, color and more from your description.
          </p>
          <Button
            size="sm"
            onClick={handleAiFill}
            disabled={aiExtract.isPending}
          >
            {aiExtract.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            AI Fill
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Item info</CardTitle>
          <CardDescription>
            Only title is required. Everything else can be filled in later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Title"
              required
              value={form.title}
              onChange={(v) => patch("title", v)}
              placeholder="e.g. Lululemon Align Pant"
              aiMarked={aiFields.has("title")}
            />
            <div className="space-y-1">
              <Label htmlFor="sku-input">SKU / Item #</Label>
              <div className="flex gap-2">
                <Input
                  id="sku-input"
                  value={form.sku}
                  onChange={(e) => patch("sku", e.target.value)}
                  placeholder="optional"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="flex-shrink-0"
                  onClick={() => setScannerOpen(true)}
                  disabled={productLookup.isPending}
                  aria-label="Scan barcode or UPC"
                  title="Scan barcode / UPC"
                >
                  {productLookup.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ScanBarcode className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            <Field
              label="Brand"
              value={form.brand}
              onChange={(v) => patch("brand", v)}
              aiMarked={aiFields.has("brand")}
            />
            <Field
              label="Style"
              value={form.style}
              onChange={(v) => patch("style", v)}
              placeholder="e.g. Align Pant 25 inch"
              aiMarked={aiFields.has("style")}
            />
            <Field
              label="Size"
              value={form.size}
              onChange={(v) => patch("size", v)}
              aiMarked={aiFields.has("size")}
            />
            <Field
              label="Color"
              value={form.color}
              onChange={(v) => patch("color", v)}
              aiMarked={aiFields.has("color")}
            />
            <div className="space-y-1">
              <Label>
                Category
                {aiFields.has("item_category") && <AiMark />}
              </Label>
              <Select
                value={form.item_category || "__none"}
                onValueChange={(v) =>
                  patch(
                    "item_category",
                    v === "__none" ? "" : (v as ItemCategory),
                  )
                }
              >
                <SelectTrigger aria-label="Category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— None —</SelectItem>
                  {ITEM_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {ITEM_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field
              label="Material"
              value={form.material}
              onChange={(v) => patch("material", v)}
              placeholder="e.g. cotton, 90% nylon"
              aiMarked={aiFields.has("material")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sourcing</CardTitle>
          <CardDescription>
            Where this came from. Pick from existing sources or add a new one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Source</Label>
              <Select
                value={form.source_id || "__none"}
                onValueChange={(v) =>
                  patch("source_id", v === "__none" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Source">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— None —</SelectItem>
                  <SelectItem value="__new">+ New source…</SelectItem>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.source_id === "__new" && (
                <Input
                  className="mt-2"
                  aria-label="New source name"
                  placeholder="New source name (e.g. Goodwill SE 14th)"
                  value={form.source_new}
                  onChange={(e) => patch("source_new", e.target.value)}
                />
              )}
            </div>
            <Field
              label="Sourced By"
              value={form.sourced_by}
              onChange={(v) => patch("sourced_by", v)}
              placeholder="e.g. Dan, Spouse, Joint"
            />
            <Field
              label="Purchase Date"
              value={form.purchase_date}
              onChange={(v) => patch("purchase_date", v)}
              type="date"
            />
            <Field
              label="Purchase Price"
              value={form.purchase_price}
              onChange={(v) => patch("purchase_price", v)}
              type="number"
              placeholder="0.00"
            />
            <Field
              label="Container / Bin"
              value={form.container}
              onChange={(v) => patch("container", v)}
              placeholder="e.g. A1, Closet shelf 3"
            />
            <div className="space-y-1">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => patch("status", v as ItemStatus)}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTAKE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {ITEM_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="i-description-public-for-listing">Description (public — for listing)</Label>
            <Textarea id="i-description-public-for-listing"
              value={form.description}
              onChange={(e) => patch("description", e.target.value)}
              rows={3}
              placeholder="What buyers should see. Brand, fit, condition summary."
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="intake-condition-notes">
              Internal Notes
              {aiFields.has("condition_notes") && <AiMark />}
            </Label>
            <Textarea
              id="intake-condition-notes"
              value={form.condition_notes}
              onChange={(e) => patch("condition_notes", e.target.value)}
              rows={3}
              placeholder="Private notes about defects, source context, etc."
            />
          </div>
        </CardContent>
      </Card>

      {/* US-2546 AC2: shoot the item here. The phone app has always taken
          photos at intake; the web form made you save, find the item again and
          open it, or switch to a different form at ?mode=snap. */}
      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
          <CardDescription>
            Optional. They upload as soon as the item is saved, and the full
            slot grid is on the item page once the category is settled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <IntakePhotoStager
            photos={stagedPhotos}
            onChange={setStagedPhotos}
            disabled={saving}
            category={form.item_category || null}
            garment={garmentDescriptorFor({
              item_category: form.item_category || null,
              title: form.title || null,
            })}
          />
        </CardContent>
      </Card>

      {/* US-2546 AC4: "measured" is a pipeline status with its own page, and
          the garment is already on the table at intake. Capturing the numbers
          now saves handling it twice. */}
      <Card>
        <CardHeader>
          <CardTitle>Measurements</CardTitle>
          <CardDescription>
            Optional. Fill what you have — the rest can be added on the prep
            page or measured from a photo later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MeasurementForm
            category={form.item_category || null}
            brand={form.brand || null}
            values={measurements}
            onChange={setMeasurements}
          />
        </CardContent>
      </Card>

      {/* US-856: grade-ROI nudge for the category being catalogued. Renders
          only when the seller's own sold history supports a lift; routes into
          the certified-grade submission flow. */}
      <GradeRoiHint
        category={form.item_category || null}
        priceHint={priceOrNull(form.purchase_price)}
        onGrade={() => navigate("/dashboard/submissions/new")}
        ctaLabel="Get a certified grade"
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => navigate("/dashboard/flipdesk/items")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => save(false)}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Save & Add another
        </Button>
        <Button onClick={() => save(true)} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save & View items
        </Button>
      </div>

      <AiFillPanel
        open={aiPanelOpen}
        onOpenChange={setAiPanelOpen}
        result={aiResult}
        currentValues={aiCurrentValues}
        fieldLabels={AI_FIELD_LABELS}
        onApply={applyAiFields}
      />

      <BarcodeScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={handleScanDetected}
      />

      {/* US-2546 AC3: Cancel, Back and the sidebar all route through here now.
          `dirty` is narrow on purpose — a dialog that fires on an untouched
          form is a dialog people learn to click through. */}
      <AlertDialog
        open={guard.blocked}
        onOpenChange={(open) => {
          if (!open) guard.cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {stagedPhotos.length > 0
                ? `This item hasn't been saved, and ${stagedPhotos.length} photo${
                    stagedPhotos.length === 1 ? "" : "s"
                  } you added here would have to be taken again.`
                : "This item hasn't been saved yet. Everything you typed will be lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancelLeave}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirmLeave}>
              Leave and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AiMark() {
  return (
    <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
      AI
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  aiMarked = false,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  placeholder?: string;
  aiMarked?: boolean;
  /**
   * US-2546 AC5: sets the real `required` attribute rather than a "*" typed
   * into the label. An asterisk in label TEXT is announced as the word "star"
   * and carries no constraint; `required` is what a screen reader reports and
   * what the browser validates against.
   */
  required?: boolean;
}) {
  // US-2335: one id per instance, from useId — NOT a slug of the label. Two
  // fields can legitimately carry the same label text, and a duplicate id
  // silently re-points the first label at the second input, which is worse than
  // no association at all.
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
        {aiMarked && <AiMark />}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        aria-required={required || undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
