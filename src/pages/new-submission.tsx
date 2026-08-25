import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { BadgeCheck, Camera, Check, ChevronLeft, ChevronRight, Loader2, ShieldCheck, Video } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  VIDEO_CAPTURE_SOURCE_FIELD,
  VIDEO_FIELD,
  VIDEO_GRADING_FIELD,
  VIDEO_GRADING_OPT_IN,
  VIDEO_SLOT_MARKS_FIELD,
} from "@/lib/video-grading-contract";
import {
  STYLE_ATTRIBUTES,
  STYLE_ATTRIBUTE_LABELS,
  STYLE_ATTRIBUTES_FIELD,
  sanitizeStyleAttributes,
  type StyleAttribute,
} from "@/lib/style-attributes";
import {
  CAPTURE_SOURCES_FIELD,
  IN_APP_CAPTURE_SOURCE,
  LIVE_CAPTURE_OPT_IN,
  LIVE_CAPTURE_OPT_IN_FIELD,
  qualifiesForLiveCapture,
} from "@/lib/photo-capture-contract";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { GRADETHREAD_TIERS, tierSupportsAuthenticityAddon } from "@/lib/constants";
import type { GradeTierKey } from "@/lib/constants";
import type { InventoryItemRow } from "@/types/database";
import { supabase } from "@/lib/supabase";
import { decideSubmitAction } from "@/lib/submit-action";
import { useBillingSummary, planLabel } from "@/hooks/use-billing-summary";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { track } from "@/lib/analytics";
import { dataUriToFile } from "@/lib/image-utils";
import type { SnapBridgeState } from "@/hooks/use-snap";
import {
  useSubmissionDraft,
  isMeaningfulDraft,
  type SubmissionDraft,
} from "@/hooks/use-submission-draft";
import { GARMENT_TYPES, GARMENT_CATEGORIES } from "@/lib/constants";
import { VideoWalkaround } from "@/components/submission/video-walkaround";
import {
  IN_APP_VIDEO_CAPTURE_SOURCE,
  serializeVideoSlotMarks,
  type VideoCaptureSource,
  type VideoSlotMarks,
} from "@/lib/video-capture";

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
  assignSlotKeys,
  type PhotoUploadItem,
} from "@/components/submission/photo-upload";
import type { RetakeBridgeState } from "@/lib/retake-submission";
import { GradePricingSummary } from "@/components/submission/grade-pricing-summary";
import { CoverageMeter } from "@/components/submission/coverage-meter";
import { coverageFromImageTypes, COVERAGE_GUARANTEE_FLOOR } from "@/lib/coverage";
import { HelpLink } from "@/components/help/help-link";

// US-2204: the "link to inventory item" dropdown loads EVERY ungraded item in
// the workspace, so it is the widest read on this page and it grows with the
// account. Eight columns feed the option label, the garment-info prefill and the
// post-submit status write — so fetch those and type the rows as the projection,
// which turns a later reach for a dropped column into a tsc error.
type LinkableItem = Pick<
  InventoryItemRow,
  | "id"
  | "user_id"
  | "title"
  | "brand"
  | "description"
  | "status"
  | "garment_type"
  | "garment_category"
>;
const LINKABLE_ITEM_COLUMNS =
  "id, user_id, title, brand, description, status, garment_type, garment_category";

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

// US-207 + US-1764: the /api/grade/submit response, shaped only as far as this
// page reads it. Declared rather than left as `any` because the XHR path parses
// the body itself and there is no fetch Response to inherit a loose type from.
interface SubmitResult {
  error?: string;
  details?: unknown;
  submissionId: string;
  status?: string;
  videoGrading?: { ok?: boolean; reason?: string };
  payment?: {
    paid?: boolean;
    method?: string;
    newIncludedUsed?: number;
    newBalance?: number;
    checkoutRequired?: boolean;
    tier?: string;
    tierPriceCents?: number;
    suggestedPack?: { credits: number; priceCents: number } | null;
  };
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
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(0);
  const [garmentInfo, setGarmentInfo] = useState<GarmentInfo | null>(null);
  const [photos, setPhotos] = useState<PhotoUploadItem[]>([]);
  // US-1766: staged photos or one walk-around clip. Photo mode is the default
  // and the fallback — a seller can switch back at any point, and a clip that
  // fails extraction lands the submission in needs_photos with photos offered.
  // US-1841: a buyer arriving from their closet ("Video grade" on a portfolio
  // item) asked for the clip path by name, so start there rather than making
  // them find the toggle. Any other value — including a typo — falls back to
  // photo mode, which always works.
  const [captureMode, setCaptureMode] = useState<"photos" | "video">(
    () => (searchParams.get("mode") === "video" ? "video" : "photos")
  );
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoMarks, setVideoMarks] = useState<VideoSlotMarks>({});
  // US-1766: how the clip entered the app. Sent as provenance; the server
  // re-normalizes it and it can only ever strengthen an earned badge.
  const [videoSource, setVideoSource] = useState<VideoCaptureSource | null>(null);
  // 0..100 while a clip is on the wire; null otherwise. Drives the progress bar
  // in VideoWalkaround — a 60 MB upload with no feedback reads as a hang.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // US-2032: staged photos live ONLY in React state — the draft autosave stores
  // a manifest (name + type), never the binaries — so navigating away destroys
  // them with no warning. Re-shooting a garment set is the most expensive thing
  // this app can ask of someone, and it happens at the exact moment the seller
  // has invested the most effort.
  //
  // Blocked ONLY while photos are staged and we are not mid-submit: a guard that
  // fires when nothing is at stake teaches people to click through it, and
  // blocking during submit would trap the caller behind their own success
  // navigation.
  const guard = useNavigationGuard(
    (photos.length > 0 || videoFile !== null) && !isSubmitting,
  );
  // US-774: synchronous double-submit guard. The button's disabled={isSubmitting}
  // only takes effect on the NEXT render, so a fast double-click can fire
  // handleSubmit twice before React commits the disabled state — which would
  // create two submissions and risk a double charge. A ref flips synchronously
  // inside the handler, so the second click is rejected immediately.
  const submitLockRef = useRef(false);
  // US-207: chosen grade tier + the post-submit payment state when a one-time
  // charge is required (included grades + credits both exhausted).
  // US-2514: `?tier=` preselects the turnaround, so a visitor who clicked
  // "Grade an item at Express" on /pricing arrives on the tier they chose
  // instead of being silently reset to Standard. Anything unrecognised falls
  // back to Standard, which is the tier the included monthly bundle covers.
  const [tier, setTier] = useState<GradeTierKey>(() => {
    const raw = searchParams.get("tier");
    return raw && raw in GRADETHREAD_TIERS ? (raw as GradeTierKey) : "standard";
  });
  // US-340: opt-in for the Verified Capture provenance booster + badge. Off by
  // default; only meaningful when every photo carries device + timestamp EXIF
  // (the server re-verifies recency/consistency/no-reuse before awarding it).
  const [verifiedCaptureOptIn, setVerifiedCaptureOptIn] = useState(false);
  // US-601: opt-in for the premium authenticity / counterfeit-confidence add-on.
  // Only offered on Premium/Express tiers (the higher tier charge covers it).
  const [authenticityAddonOptIn, setAuthenticityAddonOptIn] = useState(false);
  const [checkoutState, setCheckoutState] = useState<CheckoutRequiredState | null>(
    null
  );
  // US-2538: the submission the checkout prompt was about, kept when the seller
  // presses "Change tier". A row already exists at that point — going back to
  // the picker and pressing Submit again used to POST /api/grade/submit a
  // second time and create a SECOND submission for the same garment, which the
  // seller would then be asked to pay for twice.
  const [repricingSubmissionId, setRepricingSubmissionId] = useState<
    string | null
  >(null);
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<LinkableItem[]>([]);
  // US-949: one-tap retake bridge from submission-detail. Carries the prior
  // submission's garment details, inventory linkage, the grader's flagged photo
  // types, and the passing photos (signed URLs) so the seller only redoes the
  // flagged shots. Read once from navigation state.
  const retakeState =
    (location.state as { retake?: RetakeBridgeState } | null)?.retake ?? null;

  const [linkedItemId, setLinkedItemId] = useState<string>(
    () => searchParams.get("item") ?? retakeState?.linkedItemId ?? "none"
  );

  // US-2801: the seller's declared design features.
  //
  // AC3 is satisfied by the initialiser rather than an effect: RetakeBridgeState
  // has carried a styleAttributes field the whole time and this page — its only
  // consumer — ignored it, so a retake silently dropped the declaration.
  // Sanitized on the way in because these values come from a PRIOR submission
  // and a token retired since then would otherwise be re-sent and dropped
  // server-side, which looks to the seller like it carried when it did not.
  const [styleAttributes, setStyleAttributes] = useState<StyleAttribute[]>(
    () => sanitizeStyleAttributes(retakeState?.styleAttributes),
  );

  // US-1841: the buyer's closet item this grade answers a question about. Passed
  // through to the server, which verifies the buyer owns it before linking —
  // this is a hint, not an authorization.
  const closetItemId = searchParams.get("closet");

  // US-1935: the "Link to inventory item" dropdown must reflect the workspace
  // being submitted INTO — scope to the active workspace owner (a member acting
  // in an owner's workspace would otherwise see their own / other workspaces'
  // items via the viewer RLS policy), and guard against setState-after-unmount.
  const workspaceOwnerId = useAuthStore(
    (s) => s.activeWorkspaceOwnerId ?? s.user?.id ?? null
  );

  useEffect(() => {
    if (!workspaceOwnerId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(LINKABLE_ITEM_COLUMNS)
        .eq("user_id", workspaceOwnerId)
        .is("grade_report_id", null)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        // Don't silently render an empty "link to inventory item" list on a
        // transient failure — the user would think they have no items.
        toast.error("Couldn't load your inventory items to link.");
        return;
      }
      setInventoryItems((data ?? []) as LinkableItem[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceOwnerId]);

  const linkedItem =
    linkedItemId === "none"
      ? null
      : inventoryItems.find((i) => i.id === linkedItemId) ?? null;

  // US-952: Snap-to-Value → certified-grade bridge. The snap "Upgrade to
  // certified grade" CTA passes the exact photo + any AI-detected garment
  // type/category as navigation state so the seller upgrades with zero rework.
  const snapState =
    (location.state as { snap?: SnapBridgeState } | null)?.snap ?? null;

  // Re-stage the snap photo into the Front slot — converted to a File once, then
  // re-validated/compressed through PhotoUpload's standard path (not a raw
  // re-upload). The seeding itself happens inside PhotoUpload.
  const snapFrontFile = useMemo(
    () =>
      snapState?.imageDataUri
        ? dataUriToFile(snapState.imageDataUri, "snap-front.jpg")
        : null,
    [snapState?.imageDataUri]
  );
  const [snapSeeded, setSnapSeeded] = useState(false);

  // Prefill the garment-info form from the snap. Enum fields are only carried
  // when the classifier returned a valid value; brand/title are free text.
  const snapGarmentDefaults: Partial<GarmentInfo> | undefined = snapState
    ? {
        garmentType: (GARMENT_TYPES as readonly string[]).includes(
          snapState.garmentType ?? ""
        )
          ? (snapState.garmentType as GarmentInfo["garmentType"])
          : undefined,
        garmentCategory: (GARMENT_CATEGORIES as readonly string[]).includes(
          snapState.garmentCategory ?? ""
        )
          ? (snapState.garmentCategory as GarmentInfo["garmentCategory"])
          : undefined,
        brand: snapState.brand ?? "",
        title: snapState.title ?? "",
      }
    : undefined;

  // US-340: Verified Capture is only offerable when EVERY photo carries device
  // + capture-time provenance (read from the original before compression). The
  // server independently re-verifies recency/consistency/no-reuse, so this is
  // just a client-side availability gate for the opt-in control.
  const provenanceAvailable =
    photos.length > 0 &&
    photos.every(
      (p) =>
        p.exif?.make &&
        p.exif?.model &&
        (p.exif?.dateTimeOriginal || p.exif?.dateTime)
    );

  // US-2802: every photo came from the in-app camera dialog.
  //
  // THIS IS NOT provenanceAvailable, AND IT CANNOT BE. A camera capture is a
  // canvas.toBlob JPEG (camera-capture-dialog.tsx), which carries no EXIF at
  // all — so a seller who shot every photo in the app failed the provenance
  // check above and got the opt-in control DISABLED, while a seller who
  // uploaded library files with intact metadata got it enabled. The stronger
  // evidence was treated as the weaker one. The disabled-state copy has also
  // been promising 'available when photos are taken in-app' the whole time,
  // which was not true of this page.
  const allPhotosInApp =
    photos.length > 0 &&
    photos.every((p) => p.captureSource === IN_APP_CAPTURE_SOURCE);

  // Either kind of evidence earns the right to opt in. They are different
  // proofs of the same claim: metadata says the file is what it says it is,
  // in-app capture says we watched it happen.
  const provenanceEligible = provenanceAvailable || allPhotosInApp;

  // US-949: prefill garment info from the prior submission when retaking and no
  // inventory item drives the defaults. Enum fields are only carried when valid.
  const retakeGarmentDefaults: Partial<GarmentInfo> | undefined = retakeState
    ? {
        garmentType: (GARMENT_TYPES as readonly string[]).includes(
          retakeState.garmentType ?? ""
        )
          ? (retakeState.garmentType as GarmentInfo["garmentType"])
          : undefined,
        garmentCategory: (GARMENT_CATEGORIES as readonly string[]).includes(
          retakeState.garmentCategory ?? ""
        )
          ? (retakeState.garmentCategory as GarmentInfo["garmentCategory"])
          : undefined,
        brand: retakeState.brand ?? "",
        title: retakeState.title ?? "",
        description: retakeState.description ?? "",
      }
    : undefined;

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
      : retakeGarmentDefaults ?? snapGarmentDefaults);

  // US-949: fetch the retake's passing photos and re-stage them as Files so the
  // seller only redoes the flagged ones. Best-effort: a failed fetch just leaves
  // that slot empty. Signed URLs are short-lived but the navigation is immediate.
  const [retakeSeedFiles, setRetakeSeedFiles] = useState<
    { slotKey: string; file: File }[]
  >([]);
  useEffect(() => {
    if (!retakeState || retakeState.reusablePhotos.length === 0) return;
    let cancelled = false;
    (async () => {
      const slotKeys = assignSlotKeys(
        retakeState.reusablePhotos.map((p) => p.imageType)
      );
      const seeds: { slotKey: string; file: File }[] = [];
      await Promise.all(
        retakeState.reusablePhotos.map(async (p, i) => {
          const slotKey = slotKeys[i];
          if (!slotKey) return;
          try {
            const res = await fetch(p.signedUrl);
            if (!res.ok) return;
            const blob = await res.blob();
            const ext = blob.type.split("/")[1] || "jpg";
            seeds.push({
              slotKey,
              file: new File([blob], `${p.imageType}.${ext}`, {
                type: blob.type,
              }),
            });
          } catch {
            /* best-effort — leave the slot empty for a manual retake */
          }
        })
      );
      if (!cancelled) setRetakeSeedFiles(seeds);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-once: retakeState is stable navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // US-949: slotKeys the grader flagged, drawn with the "Retake this photo" hint.
  const flaggedSlotKeys = retakeState
    ? assignSlotKeys(retakeState.flaggedImageTypes).filter(
        (k): k is string => k !== null
      )
    : undefined;

  function handleLinkedItemChange(value: string) {
    setLinkedItemId(value);
    // Drop any prior garment info so the form re-fills from the new item.
    setGarmentInfo(null);
  }

  // US-951: local draft autosave + resume. `draftResolved` gates autosave so a
  // freshly-mounted wizard never overwrites a saved draft before the seller has
  // chosen Resume / Start over. `pendingDraft` is the detected draft awaiting
  // that choice.
  const {
    read: readDraft,
    save: saveDraft,
    clear: clearDraft,
    ready: draftReady,
  } = useSubmissionDraft();
  const [pendingDraft, setPendingDraft] = useState<SubmissionDraft | null>(null);
  const [draftResolved, setDraftResolved] = useState(false);
  const draftDetectRef = useRef(false);

  // Detect a saved draft once, after auth (and thus the per-user key) is ready.
  useEffect(() => {
    if (draftDetectRef.current || !draftReady) return;
    draftDetectRef.current = true;
    // A snap-bridge or retake arrival is an intentional fresh start with its own
    // prefill — don't interrupt it with a resume prompt.
    if (snapState || retakeState) {
      setDraftResolved(true);
      return;
    }
    const existing = readDraft();
    if (isMeaningfulDraft(existing)) {
      setPendingDraft(existing);
    } else {
      setDraftResolved(true);
    }
  }, [draftReady, readDraft, snapState, retakeState]);

  // Autosave whenever the form changes — but only once the draft is resolved,
  // and never the image binaries (only a metadata manifest of the photos).
  useEffect(() => {
    if (!draftResolved || !draftReady) return;
    const hasContent =
      garmentInfo !== null || photos.length > 0 || currentStep > 0;
    if (!hasContent) {
      clearDraft();
      return;
    }
    saveDraft({
      currentStep,
      garmentInfo,
      tier,
      verifiedCaptureOptIn,
      authenticityAddonOptIn,
      linkedItemId,
      photos: photos.map((p) => ({ imageType: p.imageType, name: p.file.name })),
    });
  }, [
    draftResolved,
    draftReady,
    saveDraft,
    clearDraft,
    currentStep,
    garmentInfo,
    tier,
    verifiedCaptureOptIn,
    authenticityAddonOptIn,
    linkedItemId,
    photos,
  ]);

  function handleResumeDraft() {
    if (!pendingDraft) return;
    setGarmentInfo(pendingDraft.garmentInfo);
    setTier(pendingDraft.tier);
    setVerifiedCaptureOptIn(pendingDraft.verifiedCaptureOptIn);
    setAuthenticityAddonOptIn(pendingDraft.authenticityAddonOptIn);
    setLinkedItemId(pendingDraft.linkedItemId);
    // Image binaries are never persisted, so never resume past the Photos step —
    // the seller re-adds their images there.
    setCurrentStep(
      pendingDraft.garmentInfo ? Math.min(pendingDraft.currentStep, 1) : 0
    );
    setPendingDraft(null);
    setDraftResolved(true);
  }

  function handleDiscardDraft() {
    clearDraft();
    setPendingDraft(null);
    setDraftResolved(true);
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

  // US-1766: the clip supplies the four required views instead of four staged
  // photos, so in video mode "ready to review" is simply "a clip is attached".
  // The server still holds the real bar: if the clip yields no usable front,
  // back, label or detail frame it comes back as needs_photos, uncharged.
  const captureReady = captureMode === "video" ? videoFile !== null : hasAllRequiredPhotos;

  // US-1277: live coverage for the in-flow meter. Scored by the shared engine
  // (US-1276) so the percent/missing zones match exactly what the server will
  // seal onto the certificate — no duplicate zone logic in the client. Computed
  // only once at least one photo is staged and a garment category is known.
  const coverage = useMemo(() => {
    if (photos.length === 0 || !garmentInfo?.garmentCategory) return null;
    return coverageFromImageTypes(
      garmentInfo.garmentCategory,
      photos.map((p) => p.imageType)
    );
  }, [photos, garmentInfo?.garmentCategory]);
  const belowCoverageFloor =
    coverage !== null && coverage.coverage_pct < COVERAGE_GUARANTEE_FLOOR;

  // US-948: auto-advance to Review the moment all four required photos are
  // present and validated, so the seller isn't left hunting for "Continue".
  // Fires only on the incomplete→complete transition (a ref tracks the prior
  // value) so returning to the Photos step from Review never bounces them
  // straight back. A brief sonner "Back to photos" action is the undo.
  //
  // Video mode deliberately does NOT auto-advance: marking the four views is
  // the whole point of the guided step, and jumping to Review the instant a
  // file is chosen would skip it.
  const prevAllRequiredRef = useRef(false);
  useEffect(() => {
    if (
      currentStep === 1 &&
      captureMode === "photos" &&
      hasAllRequiredPhotos &&
      !prevAllRequiredRef.current
    ) {
      setCurrentStep(2);
      toast.success("All required photos added — on to review.", {
        action: {
          label: "Back to photos",
          onClick: () => setCurrentStep(1),
        },
      });
    }
    prevAllRequiredRef.current = hasAllRequiredPhotos;
  }, [hasAllRequiredPhotos, currentStep, captureMode]);

  // US-1627: once the seller first reaches the Photos step, keep PhotoUpload
  // MOUNTED for the rest of the flow (hidden via CSS on other steps) instead of
  // unmounting it on Review. Previously photos lived only in the child's slot
  // state, so stepping Back from Review remounted an EMPTY uploader (while
  // Continue stayed enabled off the parent's stale `photos`), and the retake/
  // snap seed re-applied over the seller's replacements. Latching mount here —
  // rather than rendering from step 0 — avoids the async retake/snap seed race
  // (those Files are fetched before step 1) and guarantees a single seed.
  const [hasEnteredPhotoStep, setHasEnteredPhotoStep] = useState(false);
  useEffect(() => {
    if (currentStep === 1) setHasEnteredPhotoStep(true);
  }, [currentStep]);

  function handleGarmentInfoSubmit(info: GarmentInfo) {
    setGarmentInfo(info);
    setCurrentStep(1);
  }

  function handlePhotosChange(items: PhotoUploadItem[]) {
    setPhotos(items);
    // US-952: once the seeded snap photo has landed in the Front slot, stop
    // re-seeding so navigating back to this step never clobbers user edits.
    if (!snapSeeded && items.some((p) => p.imageType === "front")) {
      setSnapSeeded(true);
    }
  }

  function handleBack() {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  }

  function handleNextFromPhotos() {
    if (captureReady) {
      setCurrentStep(2);
    }
  }

  // US-1766: switching modes drops the OTHER mode's inputs. Sending both would
  // be rejected server-side anyway (a video-graded submission refuses photos so
  // its "one continuous take" claim stays exact), and silently keeping stale
  // state around is how a seller ends up submitting something they didn't mean.
  function handleUsePhotoMode() {
    setCaptureMode("photos");
    setVideoFile(null);
    setVideoMarks({});
    setVideoSource(null);
  }

  function handleUseVideoMode() {
    setCaptureMode("video");
  }

  // Link the freshly-created submission to the selected inventory item, if any.
  // Non-fatal: the submission stands on its own if linking fails.
  async function linkInventoryItem(submissionId: string) {
    if (!linkedItem) return;
    const updates: Record<string, unknown> = { submission_id: submissionId };
    if (PRE_GRADE_STATUSES.has(linkedItem.status)) {
      updates.status = "grading";
    }
    // US-1632: supabase-js returns { error }, it does NOT throw — so the old
    // try/catch never fired and a failed link was silent (the warning was dead
    // code). Read the error and surface it.
    // US-1935: pin the write to the item's owning tenant (= the workspace it was
    // loaded from) so a stale/URL-supplied linkedItemId can never touch another
    // tenant's row — belt-and-suspenders with the RLS listing_manager policy.
    const { error } = await supabase
      .from("inventory_items")
      .update(updates as never)
      .eq("id", linkedItem.id)
      .eq("user_id", linkedItem.user_id);
    if (error) {
      toast.warning(
        "Submission created, but linking to the inventory item failed."
      );
    }
  }

  /**
   * POST the multipart body, reporting UPLOAD progress.
   *
   * `fetch` has no upload-progress event, and a 60 MB clip on a phone connection
   * with no feedback is indistinguishable from a hung app — so the video path
   * goes through XHR. The photo path keeps using fetch: it is already proven,
   * and a handful of compressed stills finish before a progress bar would mean
   * anything. Returns the same { ok, status, json } shape either way.
   */
  async function postSubmission(
    formData: FormData,
    headers: Record<string, string>,
    onProgress: ((pct: number) => void) | null,
  ): Promise<{ ok: boolean; json: SubmitResult }> {
    const url = `${edgeApiUrl()}/api/grade/submit`;
    if (!onProgress) {
      const response = await fetch(url, { method: "POST", headers, body: formData });
      // US-1632: guard .json() — an HTML 502 from an infra blip isn't JSON.
      const json = (await response.json().catch(() => ({}))) as SubmitResult;
      return { ok: response.ok, json };
    }
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress(Math.min(100, (e.loaded / e.total) * 100));
        }
      };
      // 100% uploaded is not 100% done — frame extraction happens after the last
      // byte lands, so hold the bar at 100 and let the copy carry the rest.
      xhr.upload.onload = () => onProgress(100);
      xhr.onload = () => {
        let json = {} as SubmitResult;
        try {
          json = JSON.parse(xhr.responseText) as SubmitResult;
        } catch {
          json = {} as SubmitResult;
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, json });
      };
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
      xhr.ontimeout = () => reject(new Error("Upload timed out. Try again on a stronger connection."));
      xhr.send(formData);
    });
  }

  // US-2538: re-price the submission that is already on the server.
  //
  // The seller reached a checkout prompt (the row exists), pressed "Change
  // tier", and submitted again. POSTing /api/grade/submit here would create a
  // SECOND submission for the same garment, and they would be asked to pay for
  // both. /api/grade/pay/:id re-runs the payment precedence on the existing row
  // at the new tier, which is exactly this step — it is the same endpoint the
  // detail page uses when a credit pack lands mid-flow.
  async function repriceExistingSubmission(submissionId: string) {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await edgeFetch(`/api/grade/pay/${submissionId}`, {
        method: "POST",
        json: { tier },
      });
      const json = (await res.json().catch(() => ({}))) as SubmitResult;
      if (!res.ok) {
        throw new Error(json.error || "Could not update the tier.");
      }
      const payment = json.payment;
      if (payment?.paid) {
        track("grade.paid", { method: payment.method, tier });
        setRepricingSubmissionId(null);
        navigate(`/dashboard/submissions/${submissionId}`);
        return;
      }
      if (payment?.checkoutRequired) {
        setCheckoutState({
          submissionId,
          tier: (payment.tier as GradeTierKey) ?? tier,
          tierPriceCents: payment.tierPriceCents ?? tierConfig.priceCents,
          suggestedPack: payment.suggestedPack ?? null,
        });
        return;
      }
      // Unexpected shape — the row exists either way, so send them to it
      // rather than leaving them on a form that has nothing left to do.
      setRepricingSubmissionId(null);
      navigate(`/dashboard/submissions/${submissionId}`);
    } catch (err) {
      toastError(err, "Could not update the tier.");
    } finally {
      setIsSubmitting(false);
      submitLockRef.current = false;
    }
  }

  async function handleSubmit() {
    // US-2789: ONE decision, in lib/submit-action.ts, so the ordering can be
    // tested by calling it rather than by comparing string indexes in this
    // file. The gates it replaces are unchanged in behaviour and in order.
    //
    // US-2538: a submission from this session may already be waiting to be paid
    // for; re-price it rather than creating another one. US-774: a re-entrant
    // double-click is rejected synchronously.
    const action = decideSubmitAction({
      repricingSubmissionId,
      hasGarmentInfo: !!garmentInfo,
      captureMode: captureMode === "video" ? "video" : "photo",
      hasVideo: !!videoFile,
      photoCount: photos.length,
      locked: submitLockRef.current,
    });
    if (action === "ignore") return;
    if (action === "reprice") {
      await repriceExistingSubmission(repricingSubmissionId!);
      return;
    }
    // Narrowing only. decideSubmitAction already returned "ignore" for a null
    // garmentInfo, so this is unreachable — but the compiler cannot see through
    // the function, and the alternative is a non-null assertion on every one of
    // the twenty field reads below.
    if (!garmentInfo) return;
    const videoMode = captureMode === "video";
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
      // US-949: link this submission to the prior needs_photos/expired one so the
      // server references it and marks the old one superseded (excluded from
      // active counts). Server re-validates ownership + retakeable status.
      if (retakeState?.priorSubmissionId) {
        formData.append("retake_of", retakeState.priorSubmissionId);
      }
      // US-340: Verified Capture opt-in. Only sent as true when the seller
      // requested it AND every photo carries provenance EXIF; the server still
      // re-verifies recency/consistency/no-reuse before awarding the badge.
      formData.append(
        "verified_capture_opt_in",
        verifiedCaptureOptIn && provenanceAvailable ? "true" : "false"
      );
      // US-2802: the live tier. DERIVED, never a checkbox — see
      // qualifiesForLiveCapture. The seller consents to the provenance path
      // once, and whether that reaches the stronger tier is a fact about how
      // they shot the photos, not a second preference. Deriving it also means
      // we can never send the one combination grade.ts rejects (opted in with
      // a library photo in the set), so nobody is shown a submit-time error
      // for a box they were invited to tick.
      if (
        !videoMode &&
        qualifiesForLiveCapture(
          photos.map((p) => p.captureSource),
          verifiedCaptureOptIn
        )
      ) {
        formData.append(LIVE_CAPTURE_OPT_IN_FIELD, LIVE_CAPTURE_OPT_IN);
      }
      // US-601: authenticity add-on opt-in. Only sent true when the tier supports
      // it; the server re-checks the tier + the feature flag before honoring it.
      // US-2801: the seller's design declaration. Appended once per value;
      // grade.ts reads it with getAll and filters against its own allowlist,
      // so anything stale or invented is dropped rather than trusted. Nothing
      // is appended when nothing is declared, which is what keeps the composite
      // prompt byte-identical to today (AC2) — ai-grading.ts builds an empty
      // styleHintLine from an empty list.
      for (const attr of styleAttributes) {
        formData.append(STYLE_ATTRIBUTES_FIELD, attr);
      }
      formData.append(
        "authenticity_addon",
        authenticityAddonOptIn && tierSupportsAuthenticityAddon(tier) ? "true" : "false"
      );

      // US-1762: grade FROM the clip. The server extracts the frames, writes
      // them as ordinary submission images, and the normal grading flow runs
      // over them — so nothing else about this request changes shape. Photos are
      // deliberately NOT sent in this mode (the server refuses them, to keep the
      // "every view came from one take" claim exact).
      if (videoMode && videoFile) {
        // US-2504: the field names come from src/lib/video-grading-contract.ts
        // rather than being spelled here. They used to be a private handshake
        // between this file and routes/grade.ts, which is fine with one client
        // and a trap the moment a second one has to reverse-engineer them out
        // of this page.
        formData.append(VIDEO_FIELD, videoFile);
        formData.append(VIDEO_GRADING_FIELD, VIDEO_GRADING_OPT_IN);
        const marks = serializeVideoSlotMarks(videoMarks);
        if (marks) formData.append(VIDEO_SLOT_MARKS_FIELD, marks);
        // US-1766: clip provenance. Only sent when we actually know it, so an
        // unknown source stays unknown rather than defaulting to a claim.
        if (videoSource) formData.append(VIDEO_CAPTURE_SOURCE_FIELD, videoSource);
        // US-1841: link the result back to the buyer's portfolio item. Sent only
        // on the clip path — that is the grade a buyer requests from their
        // closet, and a photo grade already reaches the closet by certificate.
        if (closetItemId) formData.append("closet_item_id", closetItemId);
      }

      // Append images, their types, perceptual hashes, and provenance EXIF as
      // parallel arrays. phashes power server-side photo-reuse detection
      // (US-337). exif_metadata (US-339) is structured provenance read from the
      // ORIGINAL file before compression — "" when none was found.
      for (const photo of videoMode ? [] : photos) {
        formData.append("images", photo.file);
        formData.append("image_types", photo.imageType);
        formData.append("phashes", photo.phash ?? "");
        formData.append(
          "exif_metadata",
          photo.exif ? JSON.stringify(photo.exif) : ""
        );
        // US-2136 AC4: the measured 0..1 macro sharpness. "" for an unmeasured
        // photo — the server reads that as unknown, and unknown applies no
        // confidence cap. Sending 0 instead would claim we looked and found it
        // unreadable, which is a different and much worse statement.
        formData.append(
          "quality_scores",
          typeof photo.qualityScore === "number" ? String(photo.qualityScore) : ""
        );
        // US-2802: per-image provenance, parallel to the arrays above. The
        // badge needs BOTH this and the opt-in; either alone earns nothing.
        formData.append(CAPTURE_SOURCES_FIELD, photo.captureSource);
      }

      // US-339: optional original-image retention for server-side forensic /
      // provenance use. Heavy (uncompressed, EXIF-intact), privacy-sensitive,
      // and OFF by default so the fast compressed-upload path never regresses.
      // The server also gates storage independently (RETAIN_ORIGINAL_IMAGES),
      // so sending these is a no-op unless retention is enabled there too.
      if (!videoMode && RETAIN_ORIGINALS && photos.every((p) => p.originalFile)) {
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
      if (videoMode) setUploadProgress(0);
      const { ok, json: result } = await postSubmission(
        formData,
        requestHeaders,
        videoMode ? (pct) => setUploadProgress(pct) : null,
      );

      if (!ok) {
        const message = result.error || "Submission failed";
        if (Array.isArray(result.details)) {
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

      // US-1764: the clip yielded no usable view of a required angle, so the
      // submission abstained instead of grading what it couldn't see. NOT a
      // charge and NOT a failure — the row is retakeable, and the honest offer
      // at this point is photos.
      if (result.status === "needs_photos") {
        clearDraft();
        await linkInventoryItem(submissionId);
        toast.warning("We couldn't grade that clip.", {
          description: (result.videoGrading?.reason as string | undefined) ??
            "Record a slower walk-around in even light, or switch to photo mode.",
          action: {
            label: "Use photos",
            onClick: () => {
              handleUsePhotoMode();
              setCurrentStep(1);
            },
          },
        });
        return;
      }

      // US-951: the submission row now exists server-side, so the local draft is
      // obsolete — clear it whether payment cleared inline or a checkout is still
      // required (resuming would create a duplicate submission).
      clearDraft();

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
        setRepricingSubmissionId(null);
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
      toastError(err, "Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
      setUploadProgress(null);
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
      toastError(err, "Failed to start checkout.");
      setCheckingOut(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Submission"
        subtitle="Submit a garment for AI-powered condition grading."
              actions={<HelpLink slug="your-first-grade" label="Help: which photos to take" />}
      />

      {pendingDraft ? (
        /* US-951: a saved draft was found — offer to resume or start fresh
           before the wizard mounts, so editing can't clobber the draft. */
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Resume your saved draft?</p>
              <p className="text-xs text-muted-foreground">
                We saved your garment details from{" "}
                {new Date(pendingDraft.updatedAt).toLocaleString()}.
                {pendingDraft.photos.length > 0
                  ? ` You'll need to re-add ${pendingDraft.photos.length} photo${
                      pendingDraft.photos.length === 1 ? "" : "s"
                    }.`
                  : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDiscardDraft}
              >
                Start over
              </Button>
              <Button type="button" size="sm" onClick={handleResumeDraft}>
                Resume draft
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
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
              {/* US-950: persistent cost + billing-method summary up front so the
                  seller sees each tier's price/credit cost and whether checkout
                  will be required BEFORE uploading photos — not after. Selecting
                  a tier here drives the same `tier` state used at review. */}
              <GradePricingSummary
                tier={tier}
                onTierChange={setTier}
                creditBalance={creditBalance}
                includedUsed={includedUsed}
                includedLimit={includedLimit}
                planName={planLabel(usage.plan)}
              />
              <Separator />
              <GarmentInfoForm
                key={linkedItemId}
                onSubmit={handleGarmentInfoSubmit}
                defaultValues={garmentDefaults}
              />
            </div>
          )}

          {/* Step 2: Photos — mounted once reached, then kept mounted and
              hidden on other steps so staged photos survive Back from Review
              (US-1627). */}
          {hasEnteredPhotoStep && (
            <div className={cn("space-y-6", currentStep !== 1 && "hidden")}>
              {/* US-1766: capture mode. Two ways to give us the same four views
                  — stage them, or record one lap around the item and let us pull
                  the frames. Photos stay the default: they are what every seller
                  already knows how to do, and they are the fallback when a clip
                  cannot be read. */}
              <div className="inline-flex rounded-lg border p-1" role="group">
                <Button
                  type="button"
                  size="sm"
                  variant={captureMode === "photos" ? "default" : "ghost"}
                  onClick={handleUsePhotoMode}
                >
                  <Camera className="mr-1.5 h-4 w-4" />
                  Photos
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={captureMode === "video" ? "default" : "ghost"}
                  onClick={handleUseVideoMode}
                >
                  <Video className="mr-1.5 h-4 w-4" />
                  Walk-around video
                </Button>
              </div>

              {captureMode === "video" && (
                <VideoWalkaround
                  file={videoFile}
                  marks={videoMarks}
                  source={videoSource}
                  onClipChange={(file, source) => {
                    setVideoFile(file);
                    setVideoSource(source);
                  }}
                  onMarksChange={setVideoMarks}
                  uploadProgress={uploadProgress}
                  onUsePhotos={handleUsePhotoMode}
                />
              )}

              {/* Kept MOUNTED (hidden) in video mode for the same reason as
                  US-1627: unmounting would throw away staged photos, and photo
                  mode is the fallback a failed clip returns to. */}
              <div className={cn("space-y-6", captureMode === "video" && "hidden")}>
              {snapFrontFile && (
                <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
                  <BadgeCheck className="mr-1 inline h-3.5 w-3.5 text-brand-navy dark:text-foreground" />
                  We carried over your Snap-to-Value photo as the Front shot. Just
                  add the remaining required photos to continue.
                </p>
              )}
              {/* US-949: retake guidance — reuse the photos that passed, redo the
                  flagged ones (highlighted in amber below). */}
              {retakeState && (
                <div className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <p className="flex items-center gap-1.5 font-medium">
                    <BadgeCheck className="h-3.5 w-3.5" />
                    We brought your good photos over — just redo the flagged ones.
                  </p>
                  {retakeState.photoRequests.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {retakeState.photoRequests.map((req, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-amber-600" />
                          <span>{req}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <PhotoUpload
                onChange={handlePhotosChange}
                initialPhotos={
                  retakeState
                    ? retakeSeedFiles
                    : snapFrontFile && !snapSeeded
                      ? [{ slotKey: "front", file: snapFrontFile }]
                      : undefined
                }
                highlightSlotKeys={flaggedSlotKeys}
              />
              {/* US-1277: live coverage meter + specific missing-zone nudge.
                  Appears once a photo is staged; updates as photos are added. */}
              {coverage && <CoverageMeter coverage={coverage} />}
              {/* US-1277 AC3: below the guarantee floor we WARN (narrower
                  guarantee scope) but never hard-block submission. */}
              {belowCoverageFloor && (
                <div className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <p className="font-medium">
                    Lower coverage limits your guarantee.
                  </p>
                  <p className="mt-1">
                    You can submit now, but the Grade Accuracy Guarantee only
                    covers zones your photos actually document. Adding the
                    missing shots above widens what&apos;s protected.
                  </p>
                </div>
              )}
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
              </div>
              <div className="flex items-center justify-between pt-4">
                <Button type="button" variant="outline" onClick={handleBack}>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  onClick={handleNextFromPhotos}
                  disabled={!captureReady}
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

              {/* US-1766: in video mode there are no staged photos to preview —
                  the views don't exist until the server pulls them out of the
                  clip. Say what WILL happen rather than showing an empty grid. */}
              {captureMode === "video" && videoFile && (
                <div className="space-y-2 rounded-lg border p-3">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Video className="h-4 w-4 text-primary" />
                    Walk-around clip
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {videoFile.name} · {(videoFile.size / 1024 / 1024).toFixed(1)} MB
                    {Object.keys(videoMarks).length > 0
                      ? ` · ${Object.keys(videoMarks).length} view${
                          Object.keys(videoMarks).length === 1 ? "" : "s"
                        } marked`
                      : " · views sampled automatically"}
                    {/* US-1766: say the provenance out loud at the last screen
                        before submit, because it is what the certificate will
                        claim on the seller's behalf. */}
                    {videoSource === IN_APP_VIDEO_CAPTURE_SOURCE && " · recorded live in the app"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    We pull the front, back, tag and fabric frames out of this
                    clip and grade those. If a view isn&apos;t usable we&apos;ll
                    ask for photos instead — you won&apos;t be charged for that.
                  </p>
                </div>
              )}

              {/* Photo Thumbnails */}
              <div className={cn("space-y-3", captureMode === "video" && "hidden")}>
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
                          loading="lazy"
                          decoding="async"
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

              {/* US-2801: the seller says which features are DESIGN.
                  routes/grade.ts has filtered these against a 14-value
                  allowlist since it was written and no client ever sent one,
                  so factory distressing, raw hems and acid wash were read as
                  wear. The values are the wire tokens; the labels are the
                  words a seller would use.

                  A DECLARATION CANNOT MOVE THE GRADE, and that is not a
                  choice made here — ai-grading.ts sanitizes each value, caps
                  it, fences it as untrusted (US-346) and puts it under a
                  header reading "seller-supplied reference only — must NOT
                  affect scoring". It reaches the grader as a hint to verify
                  visually, which is the only safe thing a seller-supplied
                  string may be. */}
              {captureMode !== "video" && (
                <>
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium">
                        Any of this on purpose?
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Tell the grader which features are design, not damage,
                        so factory distressing isn&apos;t scored as wear. The
                        grader still checks the photos. Optional.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {STYLE_ATTRIBUTES.map((attr) => {
                        const on = styleAttributes.includes(attr);
                        return (
                          <button
                            key={attr}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setStyleAttributes((prev) =>
                                prev.includes(attr)
                                  ? prev.filter((a) => a !== attr)
                                  : // Kept in allowlist order rather than
                                    // click order, so the same declaration
                                    // always serializes the same way.
                                    STYLE_ATTRIBUTES.filter(
                                      (a) => a === attr || prev.includes(a),
                                    ),
                              )
                            }
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs transition-colors",
                              on
                                ? "border-primary bg-primary text-primary-foreground"
                                : "hover:border-primary/40",
                            )}
                          >
                            {STYLE_ATTRIBUTE_LABELS[attr]}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <Separator />
                </>
              )}
              {/* Verified Capture opt-in (US-340) — a positive provenance
                  booster. Only offered when every photo carries device +
                  timestamp metadata; otherwise we explain it isn't available
                  (never a penalty). */}
              <div className="space-y-2">
                <label
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3",
                    provenanceEligible
                      ? "cursor-pointer hover:border-primary/40"
                      : "opacity-60"
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    checked={verifiedCaptureOptIn && provenanceEligible}
                    disabled={!provenanceEligible}
                    onChange={(e) =>
                      setVerifiedCaptureOptIn(e.target.checked)
                    }
                  />
                  <div className="space-y-0.5">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <BadgeCheck className="h-4 w-4 text-brand-navy dark:text-foreground" />
                      Earn a Verified Capture badge
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {provenanceAvailable
                        ? "Your photos include intact device + capture-time metadata. Opt in and we'll verify their provenance (recent, consistent, unedited, not reused) to add a Verified Capture badge to your certificate and boost grade confidence. This is optional and never lowers your grade."
                        : "Available when photos are taken in-app or uploaded as originals with intact metadata. Its absence never lowers your grade — it's a bonus trust signal only."}
                    </p>
                  </div>
                </label>

                {/* Live Capture status (US-1283, rewritten by US-2802).
                    THIS USED TO BE AN ADVERT, and for a tier no client could
                    earn. It read "grade in the GradeThread app with Live
                    Capture", on the stated grounds that a browser file upload
                    cannot device-attest — true of an upload, and it sent
                    sellers to an app where Live Capture was equally unbuilt.
                    Now the camera dialog on this page feeds capture_sources, so
                    this says where the seller actually stands instead of
                    selling them something. */}
                <div className="flex items-start gap-3 rounded-lg border border-brand-red/30 bg-brand-red/5 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-red-text" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {allPhotosInApp
                        ? "Every photo was taken here, live"
                        : "Want un-fakeable condition proof?"}
                    </p>
                    <p className="text-xs text-brand-red-text/80">
                      {allPhotosInApp ? (
                        <>
                          Opt in above and this submission is checked for the
                          stronger{" "}
                          <span className="font-medium">Live-Verified</span>{" "}
                          badge — proof the photos came straight from your
                          camera rather than a stock listing. Uploading even one
                          photo from your library returns you to the standard
                          check.
                        </>
                      ) : (
                        <>
                          Use the camera button on every photo slot instead of
                          uploading files, and this submission qualifies for the
                          stronger{" "}
                          <span className="font-medium">Live-Verified</span>{" "}
                          badge. Your grade is never lowered for uploading
                          instead.
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Grade tier + pricing (US-207) */}
              {!checkoutState ? (
                <>
                  {/* US-2538: ONE tier control. This step used to render its own
                      three-button grid — the same `tier` state as the summary two
                      steps back, but with less on it: no credit balance, no included
                      count, and no warning that this tier will need a card. Two
                      controls for one decision, and the second one knew less. */}
                  <GradePricingSummary
                    tier={tier}
                    onTierChange={setTier}
                    creditBalance={creditBalance}
                    includedUsed={includedUsed}
                    includedLimit={includedLimit}
                    planName={planLabel(usage.plan)}
                  />

                  {/* US-601: premium authenticity / counterfeit-confidence
                      add-on. A SEPARATE garment-authenticity check (logos, tags,
                      stitching, hardware) — not a condition score and not the
                      photo-tamper check. Offered only on Premium/Express tiers;
                      the tier price covers it. Confidence + limitations are
                      disclosed on the report/certificate. */}
                  {tierSupportsAuthenticityAddon(tier) ? (
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:border-primary/40">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-primary"
                        checked={authenticityAddonOptIn}
                        onChange={(e) => setAuthenticityAddonOptIn(e.target.checked)}
                      />
                      <div className="space-y-0.5">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <ShieldCheck className="h-4 w-4 text-brand-navy dark:text-foreground" />
                          Add an authenticity check
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Included with {GRADETHREAD_TIERS[tier].label}. We assess
                          whether the garment looks like a genuine example of its
                          claimed brand (logos, tags, stitching, hardware) and add an
                          authenticity-confidence signal to your report. It's a
                          confidence estimate from photos — not a definitive
                          authentication or guarantee — and is separate from the
                          condition grade.
                        </p>
                      </div>
                    </label>
                  ) : (
                    <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                      <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
                      An authenticity / counterfeit-confidence check is available on
                      the Premium and Express tiers.
                    </p>
                  )}

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
                      onClick={() => {
                        // Keep the submission; the next Submit re-prices IT.
                        setRepricingSubmissionId(checkoutState.submissionId);
                        setCheckoutState(null);
                      }}
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
        </>
      )}

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

      {/* US-2032: staged photos exist only in memory — the draft autosave keeps
          a manifest, never the binaries — so leaving destroys them. Name the
          exact count, because "unsaved changes" is easy to dismiss and
          "8 photos" is not. */}
      <AlertDialog
        open={guard.blocked}
        onOpenChange={(open) => {
          if (!open) guard.cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave without submitting? Your{" "}
              {captureMode === "video" ? "clip" : "photos"} won&apos;t be saved.
            </AlertDialogTitle>
            <AlertDialogDescription>
              {captureMode === "video"
                ? "You've attached a walk-around clip. "
                : photos.length === 1
                  ? "You've added 1 photo. "
                  : `You've added ${photos.length} photos. `}
              We save your garment details, but not the images themselves — if
              you leave now you&apos;ll need to take them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancelLeave}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirmLeave}>
              Leave and discard photos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
