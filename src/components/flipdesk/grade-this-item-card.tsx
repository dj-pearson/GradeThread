import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Award,
  CheckCircle2,
  Clock,
  Loader2,
  AlertTriangle,
  ExternalLink,
  History,
  Info,
  ShieldCheck,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useItemGradingSubmissions,
  useSubmitForGrading,
  useValidateGrading,
  GRADING_TIER_COSTS,
  GRADING_TIER_CREDIT_COST,
  GRADING_TIER_LABELS,
  type GradingTier,
  type ValidationItem,
} from "@/hooks/use-grading";
import { supabase } from "@/lib/supabase";
import { GARMENT_TYPES, GARMENT_CATEGORIES } from "@/lib/constants";
import {
  deriveGarmentDefaults,
  type GarmentType,
  type GarmentCategory,
} from "@/lib/garment-mapping";
import type { GradingReadiness } from "@/lib/grading-readiness";
import type { ItemFullRow } from "@/types/database";

const TIER_OPTIONS: GradingTier[] = ["standard", "premium", "express"];

// An item's certificate_url is "<site>/cert/<id>" (see slab-image.ts). Pull the
// certificate id back out so we can resolve its Garment Passport link (US-1119).
function certIdFromUrl(url: string | null | undefined): string | null {
  if (!url || !url.includes("/cert/")) return null;
  return url.split("/cert/")[1]?.split(/[?#]/)[0] || null;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Surfaces a grade-this-item action right next to photos/measurements.
// Three states:
//   1. Item already graded — shows the score + tier + link to certificate
//   2. Submission in flight — shows status, tier, submitted-at, polls every 8s
//   3. Eligible to grade — shows tier picker + price + "Submit" with validation
// `preview`, `liveFields` and `onPatchGarment` let the card reflect readiness
// LIVE off the canvas edit form + photo cache (no save round-trip). When they're
// omitted (card used standalone) it falls back to the server /validate result.
export function GradeThisItemCard({
  item,
  preview,
  liveFields,
  onPatchGarment,
}: {
  item: ItemFullRow;
  preview?: GradingReadiness;
  liveFields?: { title: string; garment_type: string; garment_category: string };
  onPatchGarment?: (gt: GarmentType, gc: GarmentCategory) => void;
}) {
  const { data: submissions = [], isLoading } = useItemGradingSubmissions(
    item.id,
  );
  const validate = useValidateGrading();
  const submit = useSubmitForGrading();
  const qc = useQueryClient();
  const [tier, setTier] = useState<GradingTier>("standard");
  const [validation, setValidation] = useState<ValidationItem | null>(null);
  const [planRemaining, setPlanRemaining] = useState<number | null>(null);
  // Precedence inputs from validate — drive the real effective cost label.
  const [includedRemaining, setIncludedRemaining] = useState<number | null>(
    null,
  );
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  // US-1423: inline garment picker state (only shown when garment_type/
  // garment_category are the sole thing blocking grading).
  const [garmentType, setGarmentType] = useState<GarmentType | "">("");
  const [garmentCategory, setGarmentCategory] = useState<GarmentCategory | "">(
    "",
  );
  const [savingGarment, setSavingGarment] = useState(false);

  // US-1119: resolve the Garment Passport slug (if any) for a graded item from
  // the PII-free public view, so the graded card links the full provenance
  // timeline right next to the certificate.
  const certId = certIdFromUrl(item.certificate_url);
  const { data: passportSlug } = useQuery({
    queryKey: ["item_passport_link", certId],
    enabled: !!certId && item.grade_value != null,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data } = await supabase
        .from("public_passport_links")
        .select("passport_slug")
        .eq("certificate_id", certId!)
        .maybeSingle();
      return (data as { passport_slug: string } | null)?.passport_slug ?? null;
    },
  });

  const latest = submissions[0] ?? null;
  const inflight =
    latest && (latest.status === "pending" || latest.status === "processing");
  // Mandatory review: the AI grade is done but withheld until a human finalizes
  // it. Distinct from `inflight` so the card shows "submitted for human review"
  // (not "grading in progress") and doesn't re-offer the tier picker.
  const pendingReview = latest != null && latest.status === "pending_review";

  // Re-run validate whenever the tier changes or photos may have been
  // updated. Cheap call; no records created.
  useEffect(() => {
    if (inflight || pendingReview || item.grade_value != null) return;
    validate
      .mutateAsync({ inventoryItemId: item.id, tier })
      .then((res) => {
        setValidation(res.items[0] ?? null);
        setPlanRemaining(
          Number.isFinite(res.user.grades_remaining)
            ? res.user.grades_remaining
            : null,
        );
        setIncludedRemaining(res.user.included_remaining ?? null);
        setCreditBalance(res.user.credit_balance ?? null);
      })
      .catch(() => {
        /* surfaced by hook's onError */
      });
    // item.updated_at: re-validate after an edit+save (e.g. setting the
    // garment_type/garment_category that the readiness gate requires) — the
    // save bumps updated_at and invalidates items_full, refreshing this prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, item.id, item.updated_at, item.grade_value, inflight, pendingReview, submissions.length]);

  // The server /submit re-validates the PERSISTED row, but title/garment_type/
  // garment_category live in the canvas edit form until a save (photos are
  // already written to item_photos on upload/retag). Persist just those three
  // requirement fields so a live-"Ready" card always submits cleanly without a
  // separate Save. No-op when the card isn't fed live fields.
  async function persistRequirementFields() {
    if (!liveFields) return;
    const update: Record<string, unknown> = {
      title: liveFields.title.trim() || item.item_title,
      garment_type: liveFields.garment_type || null,
      garment_category: liveFields.garment_category || null,
    };
    const { error } = await supabase
      .from("inventory_items")
      .update(update as never)
      .eq("id", item.id);
    if (error) throw error;
    await qc.invalidateQueries({ queryKey: ["items_full"] });
  }

  async function doSubmit() {
    try {
      await persistRequirementFields();
      const res = await submit.mutateAsync({
        inventoryItemId: item.id,
        tier,
      });
      const ok = res.results.find((r) => r.ok && r.inventory_item_id === item.id);
      if (ok && ok.ok) {
        const costText =
          payMethod === "included"
            ? "free with your plan"
            : payMethod === "credits"
              ? `${creditCost} credit${creditCost === 1 ? "" : "s"}`
              : fmtMoney(ok.cost);
        toast.success(
          `Submitted for grading — ${tier} tier (${costText}).`,
        );
      } else {
        const failed = res.results.find((r) => !r.ok);
        toast.error(
          failed && !failed.ok
            ? `Submit failed: ${failed.error}`
            : "Submit failed.",
        );
      }
    } catch (err) {
      const e = err as Error & {
        status?: number;
        validation?: { items: ValidationItem[] };
      };
      if (e.status === 422 && e.validation) {
        const blocker =
          e.validation.items.find((i) => !i.ready)?.blockers[0] ??
          "Item not ready.";
        toast.error(blocker, { duration: 10_000 });
        setValidation(e.validation.items[0] ?? null);
      } else {
        toastError(e);
      }
    }
  }

  // US-1423: persist the inline garment picker, then re-validate so the card
  // flips straight to "Ready to grade" without leaving the composer.
  async function saveGarment(gt: GarmentType | "", gc: GarmentCategory | "") {
    if (!gt || !gc) {
      toast.error("Pick a garment type and category.");
      return;
    }
    // Live path: push into the canvas edit form. The preview clears the garment
    // blocker immediately and doSubmit persists it — no round-trip here.
    if (onPatchGarment) {
      onPatchGarment(gt, gc);
      return;
    }
    setSavingGarment(true);
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ garment_type: gt, garment_category: gc } as never)
        .eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      const res = await validate.mutateAsync({
        inventoryItemId: item.id,
        tier,
      });
      setValidation(res.items[0] ?? null);
      toast.success("Garment details saved.");
    } catch (err) {
      toastError(err, "Couldn't save.");
    } finally {
      setSavingGarment(false);
    }
  }

  // ── State 1: already graded ─────────────────────────────────────────
  if (item.grade_value != null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Award className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Grade
          </CardTitle>
          <CardDescription>
            Graded by GradeThread.
            {latest?.tier ? ` ${latest.tier} tier.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums text-brand-navy dark:text-foreground">
              {item.grade_value?.toFixed(1)}
            </span>
            {item.grade_label && (
              <Badge variant="secondary">{item.grade_label}</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {item.certificate_url && (
              <Button asChild variant="outline" size="sm">
                <a
                  href={item.certificate_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  Open certificate
                </a>
              </Button>
            )}
            {/* US-1119: link the garment's provenance timeline when a passport
                exists, so the artifacts the grade created aren't lost. */}
            {passportSlug && (
              <Button asChild variant="outline" size="sm">
                <Link to={`/passport/${passportSlug}`}>
                  <History className="mr-2 h-3.5 w-3.5" />
                  View Garment Passport
                </Link>
              </Button>
            )}
          </div>
          {/* US-1119: surface the buyer-facing trust this grade unlocks. */}
          {item.certificate_url && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                Buyers can verify this grade, and it&apos;s covered by the{" "}
                <Link
                  to="/buyer-guarantee"
                  className="font-medium text-foreground hover:underline"
                >
                  Buyer Guarantee
                </Link>
                . Build your{" "}
                <Link
                  to="/dashboard/flipdesk/verified"
                  className="font-medium text-foreground hover:underline"
                >
                  Verified Seller
                </Link>{" "}
                profile to show it off in every listing.
              </span>
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── State 2: submission in flight ───────────────────────────────────
  if (latest && inflight) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-brand-navy dark:text-foreground" />
            Grading in progress
          </CardTitle>
          <CardDescription>
            Submitted {relativeTime(latest.submitted_at)} · {latest.tier}{" "}
            tier · {fmtMoney(latest.cost)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            We&apos;re analyzing your photos. This panel updates automatically
            when the grade lands.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── State 2.5: graded, submitted for human review ───────────────────
  if (latest && pendingReview) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand-navy dark:text-foreground" />
            Submitted for human review
          </CardTitle>
          <CardDescription>
            Submitted {relativeTime(latest.submitted_at)} · {latest.tier}{" "}
            tier · {fmtMoney(latest.cost)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Your AI grade is ready and is being reviewed by a GradeThread expert
            before it becomes official. The certificate goes live and the grade
            appears here automatically once review is complete.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── State 3: eligible (or has blockers) ─────────────────────────────
  // Prefer the live preview (edit form + photo cache) so readiness updates the
  // instant the last requirement is met; fall back to the server /validate when
  // the card is used without live inputs.
  const ready = preview ? preview.ready : validation?.ready ?? false;
  const blockers = preview ? preview.blockers : validation?.blockers ?? [];
  // US-2397: things worth saying that do NOT gate the button. Today: no fabric
  // close-up, which now buys a human review instead of a refusal. Rendered
  // separately from blockers so the seller can tell "you cannot submit" from
  // "you can, and here is the cost".
  const warnings = preview ? preview.warnings : validation?.warnings ?? [];
  const lastFailed = latest && latest.status === "failed" ? latest : null;

  // US-1423: when the garment fields are the ONLY thing blocking grading, show a
  // one-tap inline picker instead of an amber "go fix it elsewhere" list.
  // (Edge blocker strings are "Missing garment_type"/"Missing garment_category".)
  const onlyGarmentBlocks =
    blockers.length > 0 &&
    blockers.every((b) => /garment_(type|category)/i.test(b));
  // Seed the picker from item_category (a default the user can override) without
  // a hook — this branch runs after conditional early returns.
  const derivedGarment = deriveGarmentDefaults(item.category);
  const effGarmentType = garmentType || derivedGarment.garment_type || "";
  const effGarmentCategory =
    garmentCategory || derivedGarment.garment_category || "";

  // Effective cost, mirroring the server precedence (grade-billing.ts):
  // Standard draws from the monthly included bundle first, then credits, then a
  // one-time charge; Premium/Express skip the included bundle (credits/charge).
  const creditCost = GRADING_TIER_CREDIT_COST[tier];
  const coveredByIncluded =
    tier === "standard" && (includedRemaining ?? 0) > 0;
  const coveredByCredits =
    !coveredByIncluded && (creditBalance ?? 0) >= creditCost;
  const payMethod: "included" | "credits" | "charge" = coveredByIncluded
    ? "included"
    : coveredByCredits
      ? "credits"
      : "charge";
  const submitLabel =
    payMethod === "included"
      ? "Submit — free"
      : payMethod === "credits"
        ? `Submit — ${creditCost} credit${creditCost === 1 ? "" : "s"}`
        : `Submit for ${fmtMoney(GRADING_TIER_COSTS[tier])}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Award className="h-4 w-4" />
          Submit for grading
        </CardTitle>
        <CardDescription>
          Send your photos to GradeThread for an AI-powered condition grade
          and shareable certificate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {lastFailed && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
            <div className="flex items-center gap-1 font-medium text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Previous attempt failed
            </div>
            <div className="mt-1 text-muted-foreground">
              {lastFailed.error ?? "Unknown error."}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Select value={tier} onValueChange={(v) => setTier(v as GradingTier)}>
            {/* Options read "Standard — $4.99", so unnamed this announces a
                PRICE and nothing about what the price buys. */}
            <SelectTrigger className="h-9 w-56 text-sm" aria-label="Grading tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIER_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {GRADING_TIER_LABELS[t]} — {fmtMoney(GRADING_TIER_COSTS[t])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {onlyGarmentBlocks ? (
          <div className="space-y-2 rounded-md border border-amber-400/40 bg-amber-50 p-3 text-xs dark:bg-amber-950/20">
            <p className="text-amber-700 dark:text-amber-300">
              Grading needs a garment type and category. We&apos;ve pre-filled a
              best guess from the item&apos;s category — confirm or adjust, then
              save.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={effGarmentType}
                onValueChange={(v) => setGarmentType(v as GarmentType)}
              >
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Garment type">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  {GARMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={effGarmentCategory}
                onValueChange={(v) => setGarmentCategory(v as GarmentCategory)}
              >
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="Garment category">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  {GARMENT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={savingGarment || !effGarmentType || !effGarmentCategory}
                onClick={() => saveGarment(effGarmentType, effGarmentCategory)}
              >
                {savingGarment && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                Save
              </Button>
            </div>
          </div>
        ) : (
          blockers.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-xs dark:bg-amber-950/20">
              {blockers.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-1 text-amber-700 dark:text-amber-300"
                >
                  <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                  {b}
                </li>
              ))}
            </ul>
          )
        )}

        {warnings.length > 0 && (
          <ul className="space-y-1 rounded-md border border-muted-foreground/25 bg-muted/40 p-2 text-xs">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1 text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {ready ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready to grade
              </span>
            ) : isLoading || (!preview && validate.isPending) ? (
              "Checking readiness…"
            ) : (
              "Fix the above before submitting."
            )}
            {planRemaining != null && (
              <span className="ml-2 text-muted-foreground/70">
                · {planRemaining} grade{planRemaining === 1 ? "" : "s"} left
                this month
              </span>
            )}
          </div>
          <Button
            onClick={doSubmit}
            disabled={!ready || submit.isPending}
          >
            {submit.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Award className="mr-2 h-4 w-4" />
            )}
            {submitLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
