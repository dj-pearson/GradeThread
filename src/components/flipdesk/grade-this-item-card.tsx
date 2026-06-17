import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Award,
  CheckCircle2,
  Clock,
  Loader2,
  AlertTriangle,
  ExternalLink,
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
import { cn } from "@/lib/utils";
import type { ItemFullRow } from "@/types/database";

const TIER_OPTIONS: GradingTier[] = ["standard", "premium", "express"];

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
export function GradeThisItemCard({ item }: { item: ItemFullRow }) {
  const { data: submissions = [], isLoading } = useItemGradingSubmissions(
    item.id,
  );
  const validate = useValidateGrading();
  const submit = useSubmitForGrading();
  const [tier, setTier] = useState<GradingTier>("standard");
  const [validation, setValidation] = useState<ValidationItem | null>(null);
  const [planRemaining, setPlanRemaining] = useState<number | null>(null);
  // Precedence inputs from validate — drive the real effective cost label.
  const [includedRemaining, setIncludedRemaining] = useState<number | null>(
    null,
  );
  const [creditBalance, setCreditBalance] = useState<number | null>(null);

  const latest = submissions[0] ?? null;
  const inflight =
    latest && (latest.status === "pending" || latest.status === "processing");

  // Re-run validate whenever the tier changes or photos may have been
  // updated. Cheap call; no records created.
  useEffect(() => {
    if (inflight || item.grade_value != null) return;
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
  }, [tier, item.id, item.updated_at, item.grade_value, inflight, submissions.length]);

  async function doSubmit() {
    try {
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
        toast.error(e.message);
      }
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

  // ── State 3: eligible (or has blockers) ─────────────────────────────
  const ready = validation?.ready ?? false;
  const blockers = validation?.blockers ?? [];
  const lastFailed = latest && latest.status === "failed" ? latest : null;

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
            <SelectTrigger className="h-9 w-56 text-sm">
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

        {blockers.length > 0 && (
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
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {ready ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready to grade
              </span>
            ) : isLoading || validate.isPending ? (
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
            className={cn(ready && "bg-brand-navy")}
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
