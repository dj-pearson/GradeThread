import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  Sparkles,
  Loader2,
  Trash2,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { PhotoUploader } from "@/components/flipdesk/photo-uploader";
import {
  AiFillPanel,
  type AcceptedField,
} from "@/components/flipdesk/ai-fill-panel";
import {
  useAiExtract,
  type AiExtractResponse,
} from "@/hooks/use-ai-extract";
import type { AiFieldSource } from "@/types/database";
import { deriveGarmentDefaults } from "@/lib/garment-mapping";
import { todayLocalDate } from "@/lib/local-date";

const DRAFT_TITLE = "Untitled draft";

// Form keys the AI can fill on a snap draft.
const APPLY_FIELDS = new Set([
  "title",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  "condition_notes",
]);

export function SnapCatalog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const { data: sources = [] } = useSources();
  const aiExtract = useAiExtract();

  const [draftId, setDraftId] = useState<string | null>(null);
  const [enriched, setEnriched] = useState(false);
  const [aiResult, setAiResult] = useState<AiExtractResponse | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [applying, setApplying] = useState(false);

  // Carried across snaps within a sourcing session.
  const [sourceId, setSourceId] = useState("");
  const [container, setContainer] = useState("");
  const [sourcedBy, setSourcedBy] = useState("");
  const [cost, setCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() =>
    todayLocalDate(),
  );

  const creatingRef = useRef(false);

  // Create a minimal draft row up front so photos have an item_id.
  async function createDraft() {
    if (!user || !workspaceOwnerId || creatingRef.current) return;
    creatingRef.current = true;
    const { data, error } = await supabase
      .from("inventory_items")
      .insert({
        user_id: workspaceOwnerId,
        title: DRAFT_TITLE,
        status: "cataloged",
      } as never)
      .select("id")
      .single();
    creatingRef.current = false;
    if (error || !data) {
      toast.error("Couldn't start a draft. Please try again.");
      return;
    }
    setDraftId((data as { id: string }).id);
    setEnriched(false);
    setAiResult(null);
  }

  useEffect(() => {
    if (!draftId) void createDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleCatalogWithAi() {
    if (!draftId) return;
    const { data: photoRows } = await supabase
      .from("item_photos")
      .select("photo_type, storage_path")
      .eq("inventory_item_id", draftId);
    const photos = ((photoRows ?? []) as {
      photo_type: string;
      storage_path: string;
    }[]).map((p) => ({
      url: supabase.storage
        .from("item-photos")
        .getPublicUrl(p.storage_path).data.publicUrl,
      type: p.photo_type,
    }));
    if (photos.length === 0) {
      toast.error("Add at least one photo first.");
      return;
    }
    try {
      const result = await aiExtract.mutateAsync({
        photos,
        item_id: draftId,
      });
      setAiResult(result);
      setAiPanelOpen(true);
    } catch {
      /* error toast handled by the hook */
    }
  }

  async function applyAiFields(accepted: AcceptedField[]) {
    if (!draftId) return;
    setApplying(true);
    try {
      const update: Record<string, unknown> = {};
      const aiSources: Record<string, AiFieldSource> = {};
      for (const a of accepted) {
        if (!APPLY_FIELDS.has(a.field)) continue;
        update[a.field] = a.value;
        aiSources[a.field] = {
          source: a.source,
          confidence: a.confidence,
          accepted: true,
        };
      }
      // Sourcing fields from the session header.
      if (sourceId) update.source_id = sourceId;
      if (container.trim()) update.container = container.trim();
      if (sourcedBy.trim()) update.sourced_by = sourcedBy.trim();
      const costNum = Number(cost);
      if (cost.trim() && Number.isFinite(costNum) && costNum >= 0) {
        update.acquired_price = costNum;
      }
      if (purchaseDate) update.acquired_date = purchaseDate;

      // AI-suggested flat measurements from brand sizing. Persist them so
      // the MeasurementForm pre-fills next time the user opens the item.
      // These are estimates — the user can override. Each filled key gets
      // a "measurements.<field>" entry in ai_field_sources so the form can
      // render an "AI" badge on each one.
      const suggestedMeasurements = aiResult?.measurements ?? null;
      if (
        suggestedMeasurements &&
        Object.keys(suggestedMeasurements).length > 0
      ) {
        update.measurements = suggestedMeasurements;
        for (const key of Object.keys(suggestedMeasurements)) {
          aiSources[`measurements.${key}`] = {
            source: "photo:tag",
            // Measurements come from brand+size+category identification,
            // not a direct measurement of the garment — calibrate so users
            // know to verify before listing.
            confidence: 0.7,
            accepted: true,
          };
        }
      }

      // US-1423: derive garment_type/garment_category (which grading requires
      // but Snap never captured) from the just-applied item_category, preferring
      // any garment values the AI returned — so a snapped item can be graded
      // without a manual re-classification in the composer. Only fill when absent.
      const itemCategory =
        typeof update.item_category === "string" ? update.item_category : null;
      const garment = deriveGarmentDefaults(itemCategory, {
        garment_type: aiResult?.suggestions?.garment_type?.value ?? null,
        garment_category: aiResult?.suggestions?.garment_category?.value ?? null,
      });
      if (garment.garment_type && update.garment_type == null) {
        update.garment_type = garment.garment_type;
      }
      if (garment.garment_category && update.garment_category == null) {
        update.garment_category = garment.garment_category;
      }

      // Done populating aiSources — persist it now if anything's in there.
      if (Object.keys(aiSources).length > 0) {
        update.ai_field_sources = aiSources;
        update.ai_enriched_at = new Date().toISOString();
      }

      const { error } = await supabase
        .from("inventory_items")
        .update(update as never)
        .eq("id", draftId);
      if (error) throw error;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      setEnriched(true);
      const measureCount = suggestedMeasurements
        ? Object.keys(suggestedMeasurements).length
        : 0;
      toast.success(
        measureCount > 0
          ? `Item cataloged with ${measureCount} suggested measurement${measureCount === 1 ? "" : "s"}.`
          : "Item cataloged.",
      );
    } catch (err) {
      toastError(err, "Failed to save the item.");
    } finally {
      setApplying(false);
    }
  }

  async function discardDraft() {
    if (!draftId) {
      navigate("/dashboard/flipdesk/items");
      return;
    }
    // Only discard an un-enriched placeholder — enriched items are real.
    const { error } = await supabase
      .from("inventory_items")
      .delete()
      .eq("id", draftId)
      .eq("title", DRAFT_TITLE);
    if (error) {
      toast.error("Couldn't discard the draft.");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    toast.success("Draft discarded.");
    navigate("/dashboard/flipdesk/items");
  }

  async function snapAnother() {
    setDraftId(null);
    await createDraft();
  }

  return (
    <div className="mx-auto max-w-md space-y-5">
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
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <Camera className="h-5 w-5" />
            Snap &amp; Catalog
          </h1>
          <p className="text-sm text-muted-foreground">
            Shoot the front and tag photos — AI fills the rest.
          </p>
        </div>
      </div>

      {/* Session header — carried to each snapped item */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sourcing</CardTitle>
          <CardDescription>Applied to every item this session.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Source</Label>
            <Select
              value={sourceId || "__none"}
              onValueChange={(v) => setSourceId(v === "__none" ? "" : v)}
            >
              <SelectTrigger aria-label="Source">
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">— None —</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="snap-container">Container</Label>
              <Input
                id="snap-container"
                value={container}
                onChange={(e) => setContainer(e.target.value)}
                placeholder="e.g. A1"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="snap-sourced-by">Sourced by</Label>
              <Input
                id="snap-sourced-by"
                value={sourcedBy}
                onChange={(e) => setSourcedBy(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="snap-cost-per-item">Cost per item</Label>
              <Input
                id="snap-cost-per-item"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="snap-purchase-date">Purchase date</Label>
              <Input
                id="snap-purchase-date"
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Cost and date apply to each item you snap — change them between
            snaps if the price varies.
          </p>
        </CardContent>
      </Card>

      {/* Photos */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Photos</CardTitle>
          <CardDescription>
            The tag/label shot is what AI reads brand, size and material from.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {draftId ? (
            <PhotoUploader itemId={draftId} currentStatus="cataloged" />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting a draft…
            </div>
          )}
        </CardContent>
      </Card>

      {enriched ? (
        <Card className="border-green-500/40 bg-green-50 dark:bg-green-950/20">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
            <p className="text-sm font-medium">Item cataloged.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={snapAnother}>
                <Camera className="mr-2 h-4 w-4" />
                Snap another
              </Button>
              <Button onClick={() => navigate("/dashboard/flipdesk/items")}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            className="flex-1"
            onClick={handleCatalogWithAi}
            disabled={!draftId || aiExtract.isPending || applying}
          >
            {aiExtract.isPending || applying ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Catalog with AI
          </Button>
          <Button variant="outline" onClick={discardDraft}>
            <Trash2 className="mr-2 h-4 w-4" />
            Discard draft
          </Button>
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Prefer typing?{" "}
        <Link
          to="/dashboard/flipdesk/intake"
          className="underline hover:text-foreground"
        >
          Use the standard intake form
        </Link>
        .
      </p>

      <AiFillPanel
        open={aiPanelOpen}
        onOpenChange={setAiPanelOpen}
        result={aiResult}
        currentValues={{}}
        fieldLabels={{
          item_category: "Category",
          condition_notes: "Condition notes",
        }}
        onApply={applyAiFields}
      />
    </div>
  );
}
