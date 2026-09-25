import { useEffect, useId, useRef, useState, type Ref } from "react";
import { useLocation, useNavigate, useSearchParams, Link } from "react-router";
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
import {
  SKU_PREVIEW_KEY,
  SKU_SEQUENCE_KEY,
  useSkuSequence,
} from "@/hooks/use-sku-sequence";
import { useSources } from "@/hooks/use-sources";
import { SourcedBySelect } from "@/components/flipdesk/sourced-by-select";
import { SkuAutoHint } from "@/components/flipdesk/sku-auto-hint";
import { BulkIntake } from "@/components/flipdesk/bulk-intake";
import { SnapCatalog } from "@/components/flipdesk/snap-catalog";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { useOfflineIntakeStatus } from "@/hooks/use-offline-intake";
import { enqueueIntake, enqueuePhotosForItem } from "@/lib/offline-queue";
import { batchSortOrders } from "@/lib/photo-order";
import {
  isDraftAlreadySaved,
  offlineSavedMessage,
  planIntakeSave,
  shouldQueueAfterError,
} from "@/lib/intake-save-plan";
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
import { useLatestRun } from "@/hooks/use-latest-run";
import { PhotoPrepError, uploadInPool, uploadItemPhoto } from "@/lib/item-photo-upload";
import { Switch } from "@/components/ui/switch";
import { useReviewFlowEnabled, useSetReviewFlow } from "@/hooks/use-review-flow";
import { firstPhotoMsFrom, reviewPath } from "@/lib/review-flow";
import { toastError } from "@/lib/toast-error";
import { FieldError } from "@/components/ui/form-feedback";
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  INTAKE_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import {
  buildIntakeInsert,
  classifyIntakeSaveError,
  photoShortfallMessage,
  priceOrNull,
  resolveIntakeSource,
  validatePurchasePrice,
  type IntakeFormState,
} from "@/pages/flipdesk/intake-plan";
import type { ItemStatus, ItemCategory } from "@/types/database";
import { todayLocalDate } from "@/lib/local-date";
import { garmentDescriptorFor } from "@/lib/measurement-templates";
import { PageHelp } from "@/components/help/page-help";
import { dataUriToFile } from "@/lib/image-utils";
import type { SnapIntakeBridgeState } from "@/lib/snap-bridge";

// Form fields the AI extractor can fill.
const AI_FILLABLE_FIELDS = [
  "title",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  "description",
  "condition_notes",
] as const;

// Not form fields, but saved from the accepted suggestion (US-1423 grading
// needs them). Only what the seller left switched on is used.
const AI_GARMENT_FIELDS = ["garment_type", "garment_category"] as const;
type AiGarment = { garment_type: string | null; garment_category: string | null };
const NO_AI_GARMENT: AiGarment = { garment_type: null, garment_category: null };

// What the review panel may offer: exactly what applyAiFields writes.
const AI_APPLICABLE_FIELDS: readonly string[] = [...AI_FILLABLE_FIELDS, ...AI_GARMENT_FIELDS];

const AI_FIELD_LABELS: Record<string, string> = {
  item_category: "Category",
  description: "Description",
  garment_type: "Garment type",
  garment_category: "Garment category",
  condition_notes: "Internal notes",
};

type FormState = IntakeFormState;

// A function, not a constant: a module-level object froze purchase_date at the
// day the bundle loaded, so a tab left open overnight saved yesterday's date.
function initialForm(): FormState {
  return {
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
}

export function FlipdeskIntakePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  // US-3418: keyed on the WORKSPACE OWNER, which is also what the insert below
  // writes into user_id and what the trigger keys its counter on. Reading the
  // acting member's own row here would show a number this save will not get.
  const skuSequence = useSkuSequence(workspaceOwnerId ?? undefined);
  const { data: sources = [] } = useSources();
  const [params] = useSearchParams();
  const location = useLocation();
  // SNAP-13: a snap arrives as navigation state. Latched once, then removed
  // from history below, so Back or a reload does not re-seed it.
  const [snapIntake] = useState(
    () => (location.state as { snap?: SnapIntakeBridgeState } | null)?.snap ?? null,
  );
  useEffect(() => {
    if (!snapIntake) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
    // Mount-once: the latched state above is what the form works from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [snapCarry, setSnapCarry] = useState(() =>
    snapIntake
      ? {
          targetPrice:
            snapIntake.targetPriceCents != null ? snapIntake.targetPriceCents / 100 : null,
          garment: {
            garment_type: snapIntake.garmentType ?? null,
            garment_category: snapIntake.garmentCategory ?? null,
          },
        }
      : null,
  );
  // What "untouched" means for the leave guard: the form as it was at mount
  // or at the last reset. Carried-forward source, bin and date are not a draft.
  const [baseline, setBaseline] = useState<FormState>(initialForm);
  const [form, setForm] = useState<FormState>(() =>
    snapIntake
      ? {
          ...baseline,
          title: snapIntake.title ?? "",
          brand: snapIntake.brand ?? "",
          condition_notes: snapIntake.conditionNote ?? "",
          purchase_price:
            snapIntake.paidCents != null ? (snapIntake.paidCents / 100).toFixed(2) : "",
          // Seen on the rack and bought: sourced, not yet cataloged.
          status: "sourced",
        }
      : baseline,
  );
  const [saving, setSaving] = useState(false);
  // Inline errors under the field that needs fixing, with focus sent there.
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    sku?: string;
    price?: string;
  }>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const skuRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  // The item id this draft will be saved under, chosen here so a retry after
  // a lost response is idempotent. Renewed after each successful save.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  // US-2546 AC2: photos staged in memory until the item row exists.
  // SNAP-13: the snap photo is staged as the Front, so it goes up through the
  // same uploadItemPhoto path after the owner-scoped insert.
  const [stagedPhotos, setStagedPhotos] = useState<StagedPhoto[]>(() => {
    const file = snapIntake?.imageDataUri
      ? dataUriToFile(snapIntake.imageDataUri, "snap-front.jpg")
      : null;
    if (!file) return [];
    let previewUrl = "";
    try {
      previewUrl = URL.createObjectURL(file);
    } catch {
      /* no preview; the upload still works */
    }
    return [{ id: "snap-front", file, previewUrl, photoType: "front", photoRole: null }];
  });
  // The stager revokes a preview when its photo is removed; whatever is still
  // staged when the page itself goes away is revoked here.
  const stagedRef = useRef(stagedPhotos);
  stagedRef.current = stagedPhotos;
  useEffect(
    () => () => {
      for (const p of stagedRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    },
    [],
  );
  // US-9204: when the first photo was staged. With the file's own capture time
  // it is the start of "seconds from first photo to Approve" on the review
  // screen. Cleared with the photos, so a batch does not inherit its first item's.
  const [firstStagedAtMs, setFirstStagedAtMs] = useState<number | null>(null);
  useEffect(() => {
    if (stagedPhotos.length === 0) setFirstStagedAtMs(null);
    else if (firstStagedAtMs == null) setFirstStagedAtMs(Date.now());
  }, [stagedPhotos.length, firstStagedAtMs]);
  // US-9204: the one-screen review flow. New accounts land on it after save;
  // existing accounts get the switch below the header until they choose.
  const reviewFlow = useReviewFlowEnabled();
  const setReviewFlow = useSetReviewFlow();
  // US-2546 AC4: "measured" is a pipeline status with its own page, so intake
  // may as well capture the numbers when the garment is already on the table.
  const [measurements, setMeasurements] = useState<
    Record<string, number | string>
  >({});
  const offline = useOfflineIntakeStatus();

  // AI Fill state
  const aiExtract = useAiExtract();
  // US-3223: ownership of the AI extract result, which survives a form reset
  // unless something invalidates it.
  const aiExtractRuns = useLatestRun();
  const [aiResult, setAiResult] = useState<AiExtractResponse | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiGarment, setAiGarment] = useState<AiGarment>(NO_AI_GARMENT);
  // SNAP-13: the snap's condition note is AI-derived and marked as such.
  const [aiFields, setAiFields] = useState<Set<string>>(
    () => new Set(snapIntake?.conditionNote ? ["condition_notes"] : []),
  );
  const [aiMeta, setAiMeta] = useState<
    Record<string, { source: string; confidence: number }>
  >(() => {
    const meta: Record<string, { source: string; confidence: number }> = {};
    if (snapIntake?.conditionNote) {
      meta.condition_notes = { source: "snap", confidence: snapIntake.confidence ?? 0 };
    }
    return meta;
  });

  // US-598: barcode/UPC scan-to-autofill.
  const productLookup = useProductLookup();
  // Same ownership rule as the AI extract: a lookup that resolves after "Save
  // & add another" belongs to the item just saved, not the blank one.
  const lookupRuns = useLatestRun();
  // The latest form, for code that runs after an await.
  const formRef = useRef(form);
  formRef.current = form;
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
        ([k, v]) => v !== baseline[k as keyof FormState],
      ) ||
      Object.keys(measurements).length > 0);
  // Only the single form has a draft to lose, and only it renders the dialog.
  // A ?mode= change keeps this component (and the draft) mounted, so it is a
  // tab switch, not a leave: blocking it froze Bulk and Snap behind a dialog
  // that was never on screen.
  const mode = params.get("mode");
  const guard = useNavigationGuard(
    dirty && !mode,
    (current, next) => next.pathname !== current.pathname,
  );

  // Alternate intake modes are separate workspaces.
  if (mode === "bulk") return <BulkIntake />;
  if (mode === "snap") return <SnapCatalog />;

  function patch<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    const errKey = k === "purchase_price" ? "price" : k;
    setFieldErrors((prev) =>
      (prev as Record<string, string | undefined>)[errKey]
        ? { ...prev, [errKey]: undefined }
        : prev,
    );
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
    // US-3223: AI Fill is disabled while the extract is pending, but Save is
    // not. "Save & add another" resets the form for the NEXT garment while this
    // request is still out, and the response then lands on the blank form --
    // opening the panel with the previous item's brand, size and color, and
    // feeding the previous item's garment_type/garment_category straight into
    // the next insert at deriveGarmentDefaults below.
    const run = aiExtractRuns.begin();
    try {
      const result = await aiExtract.mutateAsync({ text, known_fields: known });
      if (run.superseded) return;
      setAiResult(result);
      setAiPanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    }
  }

  // US-598: a scanned code resolves to product data we autofill into empty
  // fields. The code goes into SKU only when SKU is blank, and an all-digit
  // GTIN never does while SKU numbering is on (the sequence numbers it).
  async function handleScanDetected(code: string) {
    setScannerOpen(false);
    const run = lookupRuns.begin();
    const isGtin = /^\d{8,14}$/.test(code);
    const codeMaySetSku = !(isGtin && skuSequence.isEnabled);
    const writeSku = (sku: string) =>
      setForm((f) => (f.sku.trim() || !codeMaySetSku ? f : { ...f, sku }));
    const skuWasBlank = !formRef.current.sku.trim();
    const skuTaken = skuWasBlank && codeMaySetSku;
    try {
      const r = await productLookup.mutateAsync({ code });
      if (run.superseded) return;
      const before = formRef.current;
      setForm((f) => ({
        ...f,
        brand: r.brand && !f.brand.trim() ? r.brand : f.brand,
        style: r.style && !f.style.trim() ? r.style : f.style,
        title: r.productTitle && !f.title.trim() ? r.productTitle : f.title,
      }));
      writeSku(r.sku || code);
      const filled: string[] = [];
      if (r.brand && !before.brand.trim()) filled.push("brand");
      if (r.style && !before.style.trim()) filled.push("style");
      if (r.productTitle && !before.title.trim()) filled.push("title");
      if (r.found && filled.length > 0) {
        toast.success(`Autofilled ${filled.join(", ")} from the scan.`);
      } else if (r.found) {
        toast.success(skuTaken ? "Matched. Code saved to SKU." : "Matched.");
      } else {
        toast.message("No product match", {
          description: skuTaken
            ? "Saved the code as the SKU. Fill the rest in by hand."
            : "Fill the rest in by hand.",
        });
      }
    } catch {
      /* hook shows the error toast */
      if (!run.superseded) writeSku(code);
    }
  }

  function applyAiFields(accepted: AcceptedField[]) {
    const fillable = accepted.filter((a) =>
      (AI_FILLABLE_FIELDS as readonly string[]).includes(a.field),
    );
    const garment = accepted.filter((a) =>
      (AI_GARMENT_FIELDS as readonly string[]).includes(a.field),
    );
    setForm((f) => {
      const next = { ...f } as unknown as Record<string, unknown>;
      for (const a of fillable) next[a.field] = a.value;
      return next as unknown as FormState;
    });
    if (garment.length > 0) {
      setAiGarment((prev) => {
        const next = { ...prev };
        for (const a of garment) next[a.field as keyof AiGarment] = a.value;
        return next;
      });
    }
    setAiFields((prev) => {
      const next = new Set(prev);
      for (const a of fillable) next.add(a.field);
      return next;
    });
    setAiMeta((prev) => {
      const next = { ...prev };
      for (const a of fillable) {
        next[a.field] = { source: a.source, confidence: a.confidence };
      }
      return next;
    });
    // Count what was written, not what the panel returned.
    const written = fillable.length + garment.length;
    if (written > 0) {
      toast.success(`Applied ${written} AI suggestion${written === 1 ? "" : "s"}.`);
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
    description: form.description,
    condition_notes: form.condition_notes,
    garment_type: aiGarment.garment_type ?? "",
    garment_category: aiGarment.garment_category ?? "",
  };

  // Reset to add another, keeping source + container + sourced_by (the common
  // case: cataloging a batch from the same trip). A fresh draft id, so the
  // next garment is a new row. The source is the one this save used: a source
  // just created online comes back as its id, and one named offline stays
  // "__new" with its name so the next item queues against it too. The date
  // carries forward only if the seller changed it; otherwise it is today's.
  function resetForNext(source: { id: string | null; newName: string | null }) {
    const fresh = initialForm();
    const next: FormState = {
      ...fresh,
      source_id: source.id ?? (source.newName ? "__new" : ""),
      source_new: source.id ? "" : (source.newName ?? ""),
      container: form.container,
      sourced_by: form.sourced_by,
      purchase_date:
        form.purchase_date !== baseline.purchase_date ? form.purchase_date : fresh.purchase_date,
    };
    setForm(next);
    setBaseline(next);
    setDraftId(crypto.randomUUID());
    setAiFields(new Set());
    setAiMeta({});
    // US-3223: an AI extract for the garment just saved must not repopulate
    // the panel for the blank one that replaces it.
    aiExtractRuns.supersede();
    lookupRuns.supersede();
    setAiResult(null);
    setAiGarment(NO_AI_GARMENT);
    setStagedPhotos([]);
    setMeasurements({});
    setSnapCarry(null);
  }

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
      setFieldErrors({ title: "Add a title to save this item." });
      titleRef.current?.focus();
      return;
    }
    const price = validatePurchasePrice(form.purchase_price);
    if (!price.ok) {
      setFieldErrors({ price: price.message });
      priceRef.current?.focus();
      return;
    }
    setFieldErrors({});
    if (form.source_id === "__new" && !form.source_new.trim()) {
      toast.error("Enter a name for the new source.");
      return;
    }
    // Decide the route before any network call: offline, a new source is
    // created by name at flush time and staged photos are queued as bytes.
    const plan = planIntakeSave({
      online: navigator.onLine,
      source: resolveIntakeSource(form),
      photoCount: stagedPhotos.length,
    });

    setSaving(true);
    // Which call a failure came from: a 42501 from the source RPC means this
    // member may not add sources, which is not what it means on the insert.
    let stage: "source" | "insert" = "insert";
    try {
      const buildInsert = (sourceId: string | null) =>
        buildIntakeInsert({
          id: draftId,
          form,
          ownerId: workspaceOwnerId,
          sourceId,
          aiFields,
          aiMeta,
          // Only what the seller accepted in the review panel; a suggestion
          // switched off there must not reach the row.
          aiGarment: {
            garment_type: aiGarment.garment_type ?? snapCarry?.garment.garment_type ?? null,
            garment_category:
              aiGarment.garment_category ?? snapCarry?.garment.garment_category ?? null,
          },
          measurements,
          targetPrice: snapCarry?.targetPrice ?? null,
        });

      // Canonical order (front, back, tag, ...) whatever order they were
      // picked in, so the tag shot never becomes the cover. The photo id is
      // fixed per staged photo, so an online try and a queued retry agree.
      const orders = batchSortOrders(stagedPhotos.map((p) => p.photoType));
      const photoPlan = stagedPhotos.map((staged, i) => ({
        staged,
        sortOrder: orders[i]!,
        photoId: staged.photoId ?? crypto.randomUUID(),
      }));

      // Offline, or a network failure below: persist to the IndexedDB queue
      // and flush on reconnect. The draft id rides along as the item id, so
      // an online try that did land is found, not duplicated.
      const queueSave = async (sourceId: string | null, newSourceName: string | null) => {
        await enqueueIntake(buildInsert(sourceId), {
          queuedBy: user.id,
          id: draftId,
          newSourceName,
          photos: photoPlan.map((p) => ({
            blob: p.staged.file,
            name: p.staged.file.name,
            photoType: p.staged.photoType,
            photoRole: p.staged.photoRole ?? null,
            sortOrder: p.sortOrder,
            id: p.photoId,
          })),
        });
        await offline.refresh();
        resetForNext({ id: sourceId, newName: newSourceName });
      };

      if (plan.route === "queue") {
        await queueSave(plan.sourceId, plan.newSourceName);
        toast.success(offlineSavedMessage(form.title.trim(), plan));
        return;
      }

      let sourceId: string | null = plan.sourceId;
      let newSourceName: string | null = plan.newSourceName;
      try {
        if (newSourceName) {
          stage = "source";
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
              p_name: newSourceName,
              p_source_type: "other",
            },
          );
          if (error) throw error;
          sourceId = data;
          newSourceName = null;
          stage = "insert";
        }

        // A hung request on weak wifi aborts after 10s and falls back to the
        // queue like any other network failure.
        const { error } = await supabase
          .from("inventory_items")
          .insert(buildInsert(sourceId) as never)
          .select("id")
          .abortSignal(AbortSignal.timeout(10_000))
          .single();
        // 23505 on the primary key: an earlier try of this draft landed.
        if (error && !isDraftAlreadySaved(error)) throw error;
      } catch (err) {
        if (!shouldQueueAfterError(err)) throw err;
        await queueSave(sourceId, newSourceName);
        toast.success("Weak signal. Saved to your queue. It will sync on its own.");
        return;
      }
      const newId = draftId;

      // US-2546 AC2: the staged photos go up through the SAME core the item
      // page uses (src/lib/item-photo-upload.ts), three at a time, each retried
      // once. A failure here must not read as a failed save: the item exists.
      // Photos that still fail go to the offline queue against this item and
      // finish on their own; only one this device cannot prepare is lost.
      if (newId && stagedPhotos.length > 0) {
        const outcomes = await uploadInPool(photoPlan, (p) =>
          uploadItemPhoto({
            file: p.staged.file,
            itemId: newId,
            ownerFolder: workspaceOwnerId,
            photoType: p.staged.photoType,
            photoRole: p.staged.photoRole ?? null,
            sortOrder: p.sortOrder,
            photoId: p.photoId,
          }),
        );
        const uploaded = outcomes.filter((o) => o.ok).length;
        const retryable = outcomes.filter(
          (o) => !o.ok && !(o.error instanceof PhotoPrepError),
        );
        let queued = 0;
        if (retryable.length > 0) {
          try {
            await enqueuePhotosForItem({
              itemId: newId,
              ownerId: workspaceOwnerId,
              title: form.title.trim(),
              queuedBy: user.id,
              photos: retryable.map((o) => ({
                blob: o.task.staged.file,
                name: o.task.staged.file.name,
                photoType: o.task.staged.photoType,
                photoRole: o.task.staged.photoRole ?? null,
                sortOrder: o.task.sortOrder,
                id: o.task.photoId,
              })),
            });
            queued = retryable.length;
            await offline.refresh();
          } catch {
            /* no IndexedDB: reported as missing below */
          }
        }
        await qc.invalidateQueries({ queryKey: ["item_photos", newId] });
        if (queued > 0) {
          toast.message(
            `${queued} photo${queued === 1 ? "" : "s"} will finish uploading on their own.`,
          );
        }
        const shortfall = photoShortfallMessage(stagedPhotos.length, uploaded + queued);
        if (shortfall) toast.warning(shortfall);
        // US-2136: a macro shot too soft to read is worth saying once.
        const soft = outcomes
          .filter((o) => o.ok && o.result?.macro && !o.result.macro.ok)
          .map((o) => o.task.staged.photoType);
        if (soft.length > 0) {
          toast.warning(
            `The ${[...new Set(soft)].join(", ")} photo${soft.length === 1 ? " looks" : "s look"} too soft to read. Retake ${soft.length === 1 ? "it" : "them"} from the item page.`,
          );
        }
      }

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sources"] });
      // The hint under SKU named the number this item just took.
      await qc.invalidateQueries({ queryKey: [SKU_SEQUENCE_KEY, workspaceOwnerId] });
      await qc.invalidateQueries({ queryKey: [SKU_PREVIEW_KEY, workspaceOwnerId] });

      toast.success(`Added "${form.title.trim()}".`);

      if (goBackToList) {
        // US-9204: with the review flow on, the next screen is the review card,
        // not the list. The first-photo time rides along in the URL.
        if (newId && reviewFlow.enabled) {
          navigate(
            reviewPath(
              newId,
              firstPhotoMsFrom(stagedPhotos.map((p) => p.file), firstStagedAtMs),
            ),
          );
        } else {
          navigate(
            newId
              ? `/dashboard/flipdesk/items?focus=${newId}`
              : "/dashboard/flipdesk/items",
          );
        }
      } else {
        resetForNext({ id: sourceId, newName: null });
      }
    } catch (err) {
      // Never raw Postgres text: say what to change, next to the field.
      const failure = classifyIntakeSaveError(err, stage);
      if (failure.kind === "sku") {
        const msg = `You already have an item with SKU ${form.sku.trim()}. Change it or leave it blank.`;
        setFieldErrors({ sku: msg });
        skuRef.current?.focus();
        toast.error(msg);
      } else if (failure.kind === "price") {
        setFieldErrors({ price: "Price can't be negative." });
        priceRef.current?.focus();
        toast.error("Check the purchase price.");
      } else if (failure.kind === "source-denied") {
        toast.error("You can't add sources in this workspace.", {
          description: "Pick an existing source, or ask the workspace owner to add it.",
        });
      } else {
        toastError(err, "Couldn't save this item.");
      }
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
            {dirty && (
              <p className="text-sm text-muted-foreground">
                Your draft stays here while you switch.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <PageHelp slug="adding-your-first-item" />
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

      {/* US-9204 AC7: existing accounts get the review flow as a one-time switch.
          Shown only while it is off; the review screen carries the way back. */}
      {!reviewFlow.enabled && !reviewFlow.chosen && !reviewFlow.isLoading ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div>
            <p className="font-medium">Try the new flow</p>
            <p className="text-muted-foreground">
              Save lands on one review card: grade, measurements, specifics, title, price and channels, with one Approve button.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="review-flow-switch"
              checked={false}
              disabled={setReviewFlow.isPending}
              onCheckedChange={(v) =>
                setReviewFlow.mutate(v, {
                  onSuccess: () => toast.success("On. Save now lands on the review card."),
                  onError: (err) => toastError(err, "Couldn't save that."),
                })
              }
              aria-label="Try the new review flow"
            />
            <label htmlFor="review-flow-switch">Turn on</label>
            <Button
              variant="ghost"
              size="sm"
              disabled={setReviewFlow.isPending}
              onClick={() =>
                setReviewFlow.mutate(false, {
                  onError: (err) => toastError(err, "Couldn't save that."),
                })
              }
            >
              Not now
            </Button>
          </div>
        </div>
      ) : null}

      {snapCarry && (
        <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
          <p>
            Filled in from your snap
            {snapCarry.targetPrice != null
              ? `, with a target price of $${snapCarry.targetPrice.toFixed(2)} from the median sold comp`
              : ""}
            . Check the details, then save.
          </p>
        </div>
      )}

      {/* PWA install prompt — surfaces once when the app is installable. */}
      <PwaInstallBanner />

      {!offline.online && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <WifiOff className="h-4 w-4 flex-shrink-0" />
          You're offline. New items are saved to a queue and sync
          automatically when you reconnect.
        </div>
      )}
      {(offline.pending > 0 || offline.photosPending > 0) && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
          <CloudUpload className="h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
          {queueLine(offline.pending, offline.photosPending)}
          {offline.online ? ". Syncing..." : "."}
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
              inputRef={titleRef}
              error={fieldErrors.title}
            />
            <div className="space-y-1">
              <Label htmlFor="sku-input">SKU / Item #</Label>
              <div className="flex gap-2">
                <Input
                  id="sku-input"
                  ref={skuRef}
                  value={form.sku}
                  onChange={(e) => patch("sku", e.target.value)}
                  placeholder={skuSequence.nextSku ?? "optional"}
                  aria-invalid={fieldErrors.sku ? true : undefined}
                  aria-describedby={fieldErrors.sku ? "sku-input-error" : undefined}
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
              {/* US-3418: name the number this item will get if the box is left
                  alone, or offer to switch numbering on. Renders nothing while
                  the setting is still loading, so the form does not jump. */}
              <FieldError id="sku-input-error">{fieldErrors.sku}</FieldError>
              <SkuAutoHint ownerId={workspaceOwnerId ?? undefined} />
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
            <SourcedBySelect
              id="intake-sourced-by"
              className="space-y-1"
              label="Sourced By"
              value={form.sourced_by}
              onChange={(v) => patch("sourced_by", v)}
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
              inputMode="decimal"
              prefix="$"
              placeholder="0.00"
              inputRef={priceRef}
              error={fieldErrors.price}
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
            <Label htmlFor="i-description-public-for-listing">
              Description (public, for listing)
              {aiFields.has("description") && <AiMark />}
            </Label>
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
            size={form.size || null}
            style={form.style || null}
            onSizeChange={(next) => patch("size", next)}
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
          disabled={saving || productLookup.isPending}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Save & Add another
        </Button>
        <Button onClick={() => save(true)} disabled={saving || productLookup.isPending}>
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
        applicableFields={AI_APPLICABLE_FIELDS}
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

/** "2 items and 3 photos queued offline", without the empty half. */
function queueLine(items: number, photos: number): string {
  const parts: string[] = [];
  if (items > 0) parts.push(`${items} item${items === 1 ? "" : "s"}`);
  if (photos > 0) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  return `${parts.join(" and ")} queued offline`;
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
  inputRef,
  error,
  inputMode,
  prefix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  placeholder?: string;
  aiMarked?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Inline message under the field; also sets aria-invalid. */
  error?: string;
  inputMode?: "decimal" | "text";
  /** A unit shown inside the box, e.g. "$". */
  prefix?: string;
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
      <div className="relative">
        {prefix && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
          >
            {prefix}
          </span>
        )}
        <Input
          id={id}
          ref={inputRef}
          type={type}
          inputMode={inputMode}
          value={value}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={prefix ? "pl-6" : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}
