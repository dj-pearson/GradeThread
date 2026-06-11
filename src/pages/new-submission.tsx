import { useEffect, useRef, useState } from "react";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { GRADETHREAD_TIERS } from "@/lib/constants";
import type { GradeTierKey } from "@/lib/constants";
import type { InventoryItemRow } from "@/types/database";
import { supabase } from "@/lib/supabase";
import { useBillingSummary, planLabel } from "@/hooks/use-billing-summary";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { track } from "@/lib/analytics";

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

// US-339: client-side opt-in for retaining the uncompressed ORIGINAL files
// (forensic/provenance enabler). Off by default so the fast compressed path is
// the norm; the edge service gates storage independently.
const RETAIN_ORIGINALS = import.meta.env.VITE_RETAIN_ORIGINALS === "true";

// US-207: the payment state returned by /api/grade/submit when included grades
// and credits are both exhausted and a one-time charge is required.
interface CheckoutRequiredState {
  submissionId: string;
  tier: GradeTierKey;
  tierPriceCents: number;
  suggestedPack: { credits: number; priceCents: number } | null;
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(0);
  const [garmentInfo, setGarmentInfo] = useState<GarmentInfo | null>(null);
  const [photos, setPhotos] = useState<PhotoUploadItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // US-774: synchronous double-submit guard. The button's disabled={isSubmitting}
  // only takes effect on the NEXT render, so a fast double-click can fire
  // handleSubmit twice before React commits the disabled state — which would
  // create two submissions and risk a double charge. A ref flips synchronously
  // inside the handler, so the second click is rejected immediately.
  const submitLockRef = useRef(false);
  // US-207: chosen grade tier + the post-submit payment state when a one-time
  // charge is required (included grades + credits both exhausted).
  const [tier, setTier] = useState<GradeTierKey>("standard");
  const [checkoutState, setCheckoutState] = useState<CheckoutRequiredState | null>(
    null
  );
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
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

  // US-207 pricing context — driven by the billing summary (plan + credit
  // balance + included-grade counter), not the legacy per-plan price.
  const { data: summary } = useBillingSummary();
  const usage = usePlanUsage();
  const creditBalance = summary?.grades.credit_balance ?? 0;
  const includedUsed = usage.includedGrades.used;
  const includedLimit = usage.includedGrades.limit;
  const tierConfig = GRADETHREAD_TIERS[tier];
  // Mirrors the server precedence (grade-billing.ts): Standard grades draw from
  // the monthly included bundle first, then credits, then a one-time charge.
  const includedAvailable =
    tier === "standard" && includedLimit > 0 && includedUsed < includedLimit;
  const hasEnoughCredits = creditBalance >= tierConfig.creditCost;
  const estimatedMethod: "included" | "credits" | "checkout" = includedAvailable
    ? "included"
    : hasEnoughCredits
      ? "credits"
      : "checkout";

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

  // Link the freshly-created submission to the selected inventory item, if any.
  // Non-fatal: the submission stands on its own if linking fails.
  async function linkInventoryItem(submissionId: string) {
    if (!linkedItem) return;
    try {
      const updates: Record<string, unknown> = { submission_id: submissionId };
      if (PRE_GRADE_STATUSES.has(linkedItem.status)) {
        updates.status = "grading";
      }
      await supabase
        .from("inventory_items")
        .update(updates as never)
        .eq("id", linkedItem.id);
    } catch {
      toast.warning(
        "Submission created, but linking to the inventory item failed."
      );
    }
  }

  async function handleSubmit() {
    if (!garmentInfo || photos.length === 0) return;
    // US-774: reject a re-entrant double-click synchronously (see submitLockRef).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
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
      formData.append("tier", tier);
      if (garmentInfo.brand) formData.append("brand", garmentInfo.brand);
      if (garmentInfo.description) formData.append("description", garmentInfo.description);

      // Append images, their types, perceptual hashes, and provenance EXIF as
      // parallel arrays. phashes power server-side photo-reuse detection
      // (US-337). exif_metadata (US-339) is structured provenance read from the
      // ORIGINAL file before compression — "" when none was found.
      for (const photo of photos) {
        formData.append("images", photo.file);
        formData.append("image_types", photo.imageType);
        formData.append("phashes", photo.phash ?? "");
        formData.append(
          "exif_metadata",
          photo.exif ? JSON.stringify(photo.exif) : ""
        );
      }

      // US-339: optional original-image retention for server-side forensic /
      // provenance use. Heavy (uncompressed, EXIF-intact), privacy-sensitive,
      // and OFF by default so the fast compressed-upload path never regresses.
      // The server also gates storage independently (RETAIN_ORIGINAL_IMAGES),
      // so sending these is a no-op unless retention is enabled there too.
      if (RETAIN_ORIGINALS && photos.every((p) => p.originalFile)) {
        for (const photo of photos) {
          formData.append("original_images", photo.originalFile as File);
        }
      }

      // Send the active workspace owner so the submission lands in the
      // right tenant when a team member submits.
      const { activeWorkspaceOwnerId, user: storeUser } = useAuthStore.getState();
      const workspaceOwner = activeWorkspaceOwnerId ?? storeUser?.id;
      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${session.access_token}`,
      };
      if (workspaceOwner) {
        requestHeaders["X-Workspace-Owner"] = workspaceOwner;
      }
      const response = await fetch(`${edgeApiUrl()}/api/grade/submit`, {
        method: "POST",
        headers: requestHeaders,
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

      const submissionId: string = result.submissionId;
      const payment = result.payment ?? {};

      // Link the inventory item regardless of the payment outcome — the
      // submission row now exists either way.
      await linkInventoryItem(submissionId);

      // ── Payment precedence outcome (US-207) ──
      if (payment.paid) {
        track("grade.paid", { method: payment.method, tier });
        if (payment.method === "included") {
          const planName = planLabel(usage.plan);
          toast.success(
            `Free with your ${planName} plan — ${payment.newIncludedUsed} of ${includedLimit} included grades used.`
          );
        } else {
          toast.success(
            `Used ${tierConfig.creditCost} credit${tierConfig.creditCost === 1 ? "" : "s"} (balance ${payment.newBalance}). Your garment is being graded.`
          );
        }
        navigate(`/dashboard/submissions/${submissionId}`);
        return;
      }

      // Not paid — a one-time charge is required. Surface the pay/pack picker
      // inline rather than navigating away.
      if (payment.checkoutRequired) {
        setCheckoutState({
          submissionId,
          tier: (payment.tier as GradeTierKey) ?? tier,
          tierPriceCents: payment.tierPriceCents ?? tierConfig.priceCents,
          suggestedPack: payment.suggestedPack ?? null,
        });
        track("grade.pack_upsell_shown", {
          tier: payment.tier ?? tier,
          suggestedPack: payment.suggestedPack?.credits ?? null,
        });
        return;
      }

      // Unexpected shape — fall back to the detail page so the user isn't stuck.
      navigate(`/dashboard/submissions/${submissionId}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit. Please try again."
      );
    } finally {
      setIsSubmitting(false);
      submitLockRef.current = false;
    }
  }

  // ── One-time per-grade Stripe Checkout (US-207 checkout path) ──
  async function startPerGradeCheckout() {
    if (!checkoutState) return;
    setCheckingOut(true);
    try {
      const res = await edgeFetch("/api/payments/gradethread/per-grade", {
        method: "POST",
        json: {
          submissionId: checkoutState.submissionId,
          tier: checkoutState.tier,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) {
        throw new Error(json.error || "Failed to start checkout.");
      }
      window.location.href = json.url;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start checkout."
      );
      setCheckingOut(false);
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
              {/* US-339: provenance/EXIF disclosure. We read camera metadata
                  (and location, if your photo contains it) from the original
                  file to support authenticity features. It is access-controlled
                  and never shown publicly or to buyers. */}
              <p className="text-[11px] leading-snug text-muted-foreground">
                We read photo metadata (camera details and, if present, capture
                time and location) to support grade authenticity. This is kept
                private — never shown publicly or to buyers — and handled per our{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  Privacy Policy
                </a>
                .
              </p>
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

              {/* Grade tier + pricing (US-207) */}
              {!checkoutState ? (
                <>
                  <div className="space-y-3">
                    <h3 className="text-sm font-medium text-muted-foreground">
                      Grade Tier
                    </h3>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {(
                        Object.keys(GRADETHREAD_TIERS) as GradeTierKey[]
                      ).map((key) => {
                        const t = GRADETHREAD_TIERS[key];
                        const selected = tier === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setTier(key)}
                            aria-pressed={selected}
                            className={cn(
                              "rounded-lg border p-3 text-left transition-colors",
                              selected
                                ? "border-primary ring-2 ring-primary/30"
                                : "border-border hover:border-primary/40"
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">
                                {t.label}
                              </span>
                              <span className="text-sm font-semibold tabular-nums">
                                ${(t.priceCents / 100).toFixed(2)}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t.slaHours <= 1
                                ? "~1 hour"
                                : `~${t.slaHours} hours`}{" "}
                              · {t.creditCost} credit
                              {t.creditCost === 1 ? "" : "s"}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Payment estimate — mirrors the server precedence */}
                  <div className="rounded-lg bg-muted/50 p-4 text-sm">
                    {estimatedMethod === "included" ? (
                      <p className="font-medium text-emerald-600 dark:text-emerald-400">
                        Free with your {planLabel(usage.plan)} plan —{" "}
                        {includedUsed} of {includedLimit} included grades used
                        this month.
                      </p>
                    ) : estimatedMethod === "credits" ? (
                      <p className="font-medium">
                        Uses {tierConfig.creditCost} credit
                        {tierConfig.creditCost === 1 ? "" : "s"} (balance{" "}
                        {creditBalance}).
                      </p>
                    ) : (
                      <div className="flex items-center justify-between">
                        <span>One-time {tierConfig.label} grade</span>
                        <span className="font-semibold tabular-nums">
                          ${(tierConfig.priceCents / 100).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBack}
                      disabled={isSubmitting}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                    >
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
                </>
              ) : (
                /* Checkout required — included grades + credits exhausted.
                   Offer a single grade or a discounted pack (US-207). */
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">Payment required</h3>
                    <p className="text-sm text-muted-foreground">
                      You're out of included grades and credits for a{" "}
                      {GRADETHREAD_TIERS[checkoutState.tier].label} grade. Pick
                      how you'd like to pay — your submission is saved and will
                      proceed as soon as it's covered.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {/* Single grade */}
                    <div className="flex flex-col rounded-lg border p-4">
                      <p className="text-sm font-medium">Pay for this grade</p>
                      <p className="mt-1 text-2xl font-bold tabular-nums">
                        ${(checkoutState.tierPriceCents / 100).toFixed(2)}
                      </p>
                      <p className="mb-3 text-xs text-muted-foreground">
                        One-time {GRADETHREAD_TIERS[checkoutState.tier].label}{" "}
                        grade
                      </p>
                      <Button
                        type="button"
                        className="mt-auto w-full"
                        onClick={startPerGradeCheckout}
                        disabled={checkingOut}
                      >
                        {checkingOut && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Pay $
                        {(checkoutState.tierPriceCents / 100).toFixed(2)}
                      </Button>
                    </div>

                    {/* Buy a pack & save */}
                    <div className="flex flex-col rounded-lg border border-primary/40 bg-primary/5 p-4">
                      <p className="text-sm font-medium">Buy a pack &amp; save</p>
                      <p className="mt-1 text-2xl font-bold">17%+</p>
                      <p className="mb-3 text-xs text-muted-foreground">
                        Credits never expire. 1 credit = 1 Standard grade.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        className="mt-auto w-full"
                        onClick={() => setPackDialogOpen(true)}
                        disabled={checkingOut}
                      >
                        See credit packs
                      </Button>
                    </div>
                  </div>

                  <div className="pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setCheckoutState(null)}
                      disabled={checkingOut}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Change tier
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mid-flow credit-pack purchase. On return, the submission auto-retries
          the payment precedence (?pay_retry) so it proceeds without a second
          click (US-207). */}
      {checkoutState && (
        <CreditPackDialog
          open={packDialogOpen}
          onOpenChange={setPackDialogOpen}
          returnPath={`/dashboard/submissions/${checkoutState.submissionId}?pay_retry=1&tier=${checkoutState.tier}`}
        />
      )}
    </div>
  );
}
