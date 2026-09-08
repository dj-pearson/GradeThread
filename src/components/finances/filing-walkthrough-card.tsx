import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  FileText,
  ListChecks,
  MinusCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  ymd,
} from "@/lib/tax-profile";
import { fetchReviewCount } from "@/lib/books-review";
import { fetchMileageSummary, fetchVehicleYear } from "@/lib/mileage";
import { fetchHomeOfficeYear } from "@/lib/home-office";
import { fetchBridge, fetchForms, fetchPlatformsWithSales } from "@/lib/form-1099k";
import { duePeriods, fetchPayments } from "@/lib/estimated-tax";
import { fetchClosedPeriods } from "@/lib/period-close";
import {
  FILING_FRAMING,
  RECEIPT_THRESHOLD_DOLLARS,
  filingProgress,
  filingSteps,
  formsToFile,
  type FilingSignals,
  type FilingStep,
  type StepStatus,
} from "@/lib/filing-walkthrough";
import type { MoneyView } from "@/pages/flipdesk/nav-tabs";

// US-3137 — the order, on the screen.
//
// Everything below is derived. This component stores nothing, writes nothing,
// and asks for nothing the seller has not already given us.

function viewLink(view: MoneyView): string {
  return `/dashboard/flipdesk/money?view=${view}`;
}

const STATUS_ICON: Record<StepStatus, typeof Check> = {
  done: Check,
  needs_you: Circle,
  not_started: Circle,
  not_applicable: MinusCircle,
};

const STATUS_LABEL: Record<StepStatus, string> = {
  done: "Done",
  needs_you: "Needs you",
  not_started: "Not started",
  not_applicable: "Does not apply",
};

function StepRow({ step, open, onToggle }: {
  step: FilingStep;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = STATUS_ICON[step.status];
  const muted = step.status === "done" || step.status === "not_applicable";
  return (
    <li className="border-b last:border-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 py-3 text-left"
      >
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            muted ? "text-muted-foreground" : "text-foreground",
          )}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "text-[14px]",
                muted ? "text-muted-foreground" : "font-medium",
              )}
            >
              {step.title}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {STATUS_LABEL[step.status]}
            </span>
          </span>
          {step.detail && (
            <span className="block text-[13px] leading-relaxed text-muted-foreground">
              {step.detail}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 pb-4 pl-7">
          <p className="text-[13px] leading-relaxed">{step.why}</p>
          {step.ifSkipped && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Leave it and: {step.ifSkipped}
            </p>
          )}
          <p className="text-[12px] text-muted-foreground">
            Feeds {step.formLines.join(", ")}.
          </p>
          <Button asChild variant="outline" size="sm" className="h-8">
            <Link to={viewLink(step.view)}>
              Go there
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      )}
    </li>
  );
}

export function FilingWalkthroughCard() {
  const user = useAuthStore((s) => s.user);
  // Defaults to LAST year: the filing walkthrough is a March task, and a seller
  // opening it in March means the year that just ended.
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;

  const { data: profile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });

  // fetchTaxProfile hands back TAX_PROFILE_DEFAULTS when there is no row, which
  // is right for every screen that just needs a fiscal year and wrong here:
  // this card has to tell "chose the defaults" apart from "never opened it".
  const { data: profileSaved = false } = useQuery({
    queryKey: ["tax-profile-exists", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase
        .from("tax_profiles")
        .select("id", { count: "exact", head: true });
      return (count ?? 0) > 0;
    },
    staleTime: 30 * 60 * 1000,
  });

  const { data: signals, isLoading } = useQuery({
    queryKey: ["filing-signals", user?.id, year],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Omit<FilingSignals,
      "taxYear" | "profileSaved" | "entityType" | "accountingMethod" | "hasEin"
    >> => {
      const [
        reviewIssueCount,
        mileage,
        vehicle,
        homeOffice,
        platforms,
        forms,
        payments,
        closed,
      ] = await Promise.all([
        fetchReviewCount(from, to).catch(() => 0),
        fetchMileageSummary(from, to).catch(() => null),
        fetchVehicleYear(year).catch(() => null),
        fetchHomeOfficeYear(year).catch(() => null),
        fetchPlatformsWithSales(year).catch(() => []),
        fetchForms(year).catch(() => []),
        fetchPayments(year).catch(() => []),
        fetchClosedPeriods().catch(() => []),
      ]);

      const { count: withoutReceipt } = await supabase
        .from("flipdesk_expenses")
        .select("id", { count: "exact", head: true })
        .gte("spent_on", from)
        .lt("spent_on", to)
        .gt("amount", RECEIPT_THRESHOLD_DOLLARS)
        .is("receipt_path", null);

      const { data: snapRows } = await supabase
        .from("inventory_snapshots")
        .select("as_of, items_without_cost")
        .in("as_of", [from, to]);
      const snaps = (snapRows ?? []) as {
        as_of: string;
        items_without_cost: number;
      }[];
      const closing = snaps.find((s) => s.as_of === to);

      // Only the platforms with a form entered are worth a bridge call. With
      // none entered this loop makes zero round trips, which is the common case
      // and the one that has to stay cheap.
      let bridgesWithVariance = 0;
      for (const f of forms) {
        const bridge = await fetchBridge(f.platform, year).catch(() => null);
        if (bridge && bridge.form_present && bridge.variance_cents !== 0) {
          bridgesWithVariance += 1;
        }
      }

      const today = ymd(new Date());
      return {
        reviewIssueCount,
        expensesWithoutReceipt: withoutReceipt ?? 0,
        openingSnapshot: snaps.some((s) => s.as_of === from),
        closingSnapshot: Boolean(closing),
        snapshotItemsWithoutCost: closing?.items_without_cost ?? 0,
        platformsWithSales: platforms.length,
        bridgesEntered: forms.length,
        bridgesWithVariance,
        tripCount: mileage?.trip_count ?? 0,
        vehicleAnswered: vehicle != null,
        homeOfficeAnswered: homeOffice != null,
        homeOfficeClaimed: (homeOffice?.square_feet ?? 0) > 0,
        paymentsRecorded: new Set(payments.map((p) => p.quarter)).size,
        duePeriodsElapsed: duePeriods(year).filter((d) => d.dueOn <= today)
          .length,
        periodClosed: closed.some(
          (c) =>
            c.period_start === from &&
            c.period_end === to &&
            c.reopened_at == null,
        ),
      };
    },
  });

  const full: FilingSignals | null = useMemo(() => {
    if (!signals) return null;
    return {
      ...signals,
      taxYear: year,
      profileSaved,
      entityType: profile?.entity_type ?? TAX_PROFILE_DEFAULTS.entity_type,
      accountingMethod:
        profile?.accounting_method ?? TAX_PROFILE_DEFAULTS.accounting_method,
      hasEin: profile?.has_ein ?? TAX_PROFILE_DEFAULTS.has_ein,
    };
  }, [signals, year, profileSaved, profile]);

  const steps = useMemo(() => (full ? filingSteps(full) : []), [full]);
  const progress = useMemo(() => filingProgress(steps), [steps]);
  const forms = useMemo(() => (full ? formsToFile(full) : []), [full]);

  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear - 1, thisYear - 2];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Getting {year} filed
          </CardTitle>
          <Select
            value={String(year)}
            onValueChange={(v) => setYear(Number(v))}
          >
            <SelectTrigger className="h-8 w-28" aria-label="Tax year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !full ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed">
              {progress.done} of {progress.total} done.{" "}
              {progress.next
                ? `Next: ${progress.next.title.toLowerCase()}.`
                : "Nothing left on the list."}
            </p>

            <ul className="border-t">
              {steps.map((s) => (
                <StepRow
                  key={s.key}
                  step={s}
                  open={openKey === s.key}
                  onToggle={() =>
                    setOpenKey((k) => (k === s.key ? null : s.key))
                  }
                />
              ))}
            </ul>

            <div className="space-y-2 border-t pt-4">
              <p className="flex items-center gap-2 text-[14px] font-medium">
                <FileText className="h-4 w-4 text-muted-foreground" />
                What you end up filing
              </p>
              <ul className="space-y-2">
                {forms.map((f) => (
                  <li key={f.form} className="text-[13px] leading-relaxed">
                    <span className="font-medium">{f.form}</span> — {f.what}{" "}
                    <span className="text-muted-foreground">{f.because}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        <p className="border-t pt-4 text-[12px] leading-relaxed text-muted-foreground">
          {FILING_FRAMING}
        </p>
      </CardContent>
    </Card>
  );
}
