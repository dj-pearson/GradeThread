import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { edgeApiUrl } from "@/lib/edge-api";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";
import type { InventoryItemRow } from "@/types/database";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";

// Item statuses from which a submission moves the item into 'grading'.
const PRE_GRADE_STATUSES = new Set([
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
]);
import {
  GarmentInfoForm,
  type GarmentInfo,
} from "@/components/submission/garment-info-form";
import {
  PhotoUpload,
  type PhotoUploadItem,
} from "@/components/submission/photo-upload";

const STEPS = [
  { label: "Garment Info", description: "Describe your garment" },
  { label: "Photos", description: "Upload garment photos" },
  { label: "Review & Pay", description: "Confirm and submit" },
] as const;

function formatLabel(value: string): string {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function StepIndicator({
  currentStep,
}: {
  currentStep: number;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((step, index) => (
        <div key={step.label} className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors",
                index < currentStep
                  ? "border-primary bg-primary text-primary-foreground"
                  : index === currentStep
                    ? "border-primary text-primary"
                    : "border-muted-foreground/30 text-muted-foreground/50"
              )}
            >
              {index < currentStep ? (
                <Check className="h-4 w-4" />
              ) : (
                index + 1
              )}
            </div>
            <div className="hidden sm:block">
              <p
                className={cn(
                  "text-sm font-medium",
                  index <= currentStep
                    ? "text-foreground"
                    : "text-muted-foreground/50"
                )}
              >
                {step.label}
              </p>
            </div>
          </div>
          {index < STEPS.length - 1 && (
            <div
              className={cn(
                "h-0.5 w-8 sm:w-12",
                index < currentStep ? "bg-primary" : "bg-muted-foreground/20"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function NewSubmissionPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(0);
  const [garmentInfo, setGarmentInfo] = useState<GarmentInfo | null>(null);
  const [photos, setPhotos] = useState<PhotoUploadItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemRow[]>([]);
  const [linkedItemId, setLinkedItemId] = useState<string>(
    () => searchParams.get("item") ?? "none"
  );

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("inventory_items")
        .select("*")
        .is("grade_report_id", null)
        .order("created_at", { ascending: false });
      setInventoryItems((data ?? []) as InventoryItemRow[]);
    })();
  }, []);

  const linkedItem =
    linkedItemId === "none"
      ? null
      : inventoryItems.find((i) => i.id === linkedItemId) ?? null;

  const garmentDefaults: Partial<GarmentInfo> | undefined =
    garmentInfo ??
    (linkedItem
      ? {
          garmentType: linkedItem.garment_type ?? undefined,
          garmentCategory: linkedItem.garment_category ?? undefined,
          brand: linkedItem.brand ?? "",
          title: linkedItem.title,
          description: linkedItem.description ?? "",
        }
      : undefined);

  function handleLinkedItemChange(value: string) {
    setLinkedItemId(value);
    // Drop any prior garment info so the form re-fills from the new item.
    setGarmentInfo(null);
  }

  const plan = profile?.plan ?? "free";
  const planConfig = PLANS[plan as PlanKey];
  const pricePerGrade =
    planConfig.priceMonthly === null || planConfig.priceMonthly === 0
      ? 0
      : planConfig.priceMonthly;

  const requiredPhotosUploaded = photos.filter((p) =>
    ["front", "back", "label", "detail"].includes(p.imageType)
  );
  const hasAllRequiredPhotos =
    requiredPhotosUploaded.some((p) => p.imageType === "front") &&
    requiredPhotosUploaded.some((p) => p.imageType === "back") &&
    requiredPhotosUploaded.some((p) => p.imageType === "label") &&
    requiredPhotosUploaded.some((p) => p.imageType === "detail");

  function handleGarmentInfoSubmit(info: GarmentInfo) {
    setGarmentInfo(info);
    setCurrentStep(1);
  }

  function handlePhotosChange(items: PhotoUploadItem[]) {
    setPhotos(items);
  }

  function handleBack() {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  }

  function handleNextFromPhotos() {
    if (hasAllRequiredPhotos) {
      setCurrentStep(2);
    }
  }

  async function handleSubmit() {
    if (!garmentInfo || photos.length === 0) return;
    setIsSubmitting(true);

    try {
      // Get current session for auth token
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("You must be logged in to submit a garment.");
        return;
      }

      // Build multipart form data matching edge function expectations
      const formData = new FormData();
      formData.append("garment_type", garmentInfo.garmentType);
      formData.append("garment_category", garmentInfo.garmentCategory);
      formData.append("title", garmentInfo.title);
      if (garmentInfo.brand) formData.append("brand", garmentInfo.brand);
      if (garmentInfo.description) formData.append("description", garmentInfo.description);

      // Append images and their types as parallel arrays
      for (const photo of photos) {
        formData.append("images", photo.file);
        formData.append("image_types", photo.imageType);
      }

      const response = await fetch(`${edgeApiUrl()}/api/grade/submit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        const message = result.error || "Submission failed";
        if (result.details && Array.isArray(result.details)) {
          toast.error(message, {
            description: result.details.join(", "),
          });
        } else {
          toast.error(message);
        }
        return;
      }

      // Link the submission to an inventory item if one was selected.
      if (linkedItem && result.submissionId) {
        try {
          const updates: Record<string, unknown> = {
            submission_id: result.submissionId,
          };
          if (PRE_GRADE_STATUSES.has(linkedItem.status)) {
            updates.status = "grading";
          }
          await supabase
            .from("inventory_items")
            .update(updates as never)
            .eq("id", linkedItem.id);
        } catch {
          // Linking is non-fatal — the submission was still created.
          toast.warning(
            "Submission created, but linking to the inventory item failed."
          );
        }
      }

      toast.success("Submission created! Your garment is being graded.", {
        description: "You'll be redirected to the submission details.",
      });

      // Navigate to the submission detail page
      navigate(`/dashboard/submissions/${result.submissionId}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Submission</h1>
        <p className="text-muted-foreground">
          Submit a garment for AI-powered condition grading.
        </p>
      </div>

      <StepIndicator currentStep={currentStep} />

      <Card>
        <CardHeader>
          <CardTitle>{STEPS[currentStep]?.label}</CardTitle>
          <CardDescription>{STEPS[currentStep]?.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Step 1: Garment Info */}
          {currentStep === 0 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="linked-item">
                  Link to inventory item{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={linkedItemId}
                  onValueChange={handleLinkedItemChange}
                >
                  <SelectTrigger id="linked-item" className="w-full">
                    <SelectValue placeholder="No linked item" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No linked item</SelectItem>
                    {inventoryItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.title}
                        {item.brand ? ` — ${item.brand}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {linkedItem && (
                  <p className="text-xs text-muted-foreground">
                    Garment details below were pre-filled from this item. The
                    grade will flow back into its inventory record.
                  </p>
                )}
              </div>
              <Separator />
              <GarmentInfoForm
                key={linkedItemId}
                onSubmit={handleGarmentInfoSubmit}
                defaultValues={garmentDefaults}
              />
            </div>
          )}

          {/* Step 2: Photos */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <PhotoUpload onChange={handlePhotosChange} />
              <div className="flex items-center justify-between pt-4">
                <Button type="button" variant="outline" onClick={handleBack}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  onClick={handleNextFromPhotos}
                  disabled={!hasAllRequiredPhotos}
                >
                  Continue
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Review & Pay */}
          {currentStep === 2 && garmentInfo && (
            <div className="space-y-6">
              {/* Garment Summary */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Garment Details
                </h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div className="text-muted-foreground">Type</div>
                  <div className="font-medium">
                    {formatLabel(garmentInfo.garmentType)}
                  </div>
                  <div className="text-muted-foreground">Category</div>
                  <div className="font-medium">
                    {formatLabel(garmentInfo.garmentCategory)}
                  </div>
                  {garmentInfo.brand && (
                    <>
                      <div className="text-muted-foreground">Brand</div>
                      <div className="font-medium">{garmentInfo.brand}</div>
                    </>
                  )}
                  <div className="text-muted-foreground">Title</div>
                  <div className="font-medium">{garmentInfo.title}</div>
                  {garmentInfo.description && (
                    <>
                      <div className="text-muted-foreground">Description</div>
                      <div className="font-medium">
                        {garmentInfo.description}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <Separator />

              {/* Photo Thumbnails */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Photos ({photos.length})
                </h3>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {photos.map((photo, index) => (
                    <div key={index} className="space-y-1">
                      <div className="aspect-square overflow-hidden rounded-md border">
                        <img
                          src={photo.preview}
                          alt={`${photo.imageType} photo`}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <p className="text-center text-[10px] text-muted-foreground">
                        {formatLabel(photo.imageType)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Price */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Pricing
                </h3>
                <div className="rounded-lg bg-muted/50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">AI Condition Grade</span>
                    <span className="font-medium">
                      {pricePerGrade === 0
                        ? "Included in plan"
                        : `$${pricePerGrade}/mo (${planConfig.name} plan)`}
                    </span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-4">
                <Button type="button" variant="outline" onClick={handleBack} disabled={isSubmitting}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    "Submit for Grading"
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
