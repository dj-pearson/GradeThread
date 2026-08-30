import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Info, PiggyBank } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import { ensureLedgerBuilt, fetchLedgerEntries } from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  dollarInputToCents,
  ymd,
  type FilingStatus,
} from "@/lib/tax-profile";
import {
  duePeriods,
  estimateTax,
  fetchPayments,
  fetchTaxRateYear,
  nextDue,
  savePayment,
  setAsidePercent,
} from "@/lib/estimated-tax";

// US-2991 — what to set aside, and when it is due.
//
// The headline is a dollar figure a seller can act on today. Everything under
// it exists to make that figure trustworthy: the assumptions are named, the
// exact half is separated from the assumed half, and once payments are recorded
// the screen shows the SHORTFALL rather than restating the ideal.

const RATE_CHOICES = [
  { bps: 1000, label: "10%" },
  { bps: 1200, label: "12%" },
  { bps: 2200, label: "22%" },
  { bps: 2400, label: "24%" },
  { bps: 3200, label: "32%" },
  { bps: 3500, label: "35%" },
  { bps: 3700, label: "37%" },
];

export function EstimatedTaxCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [preferSafeHarbour, setPreferSafeHarbour] = useState(false);
  const [payingQuarter, setPayingQuarter] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const { data: profile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });

  const { data: rates, isLoading: ratesLoading } = useQuery({
    queryKey: ["tax-rate-year", year],
    queryFn: () => fetchTaxRateYear(year),
  });

  // Net profit for the CALENDAR year: estimated tax follows the calendar, not
  // the seller's fiscal year, because the due dates do.
  const { data: entries, isLoading: entriesLoading } = useQuery({
    queryKey: ["estimated-tax-entries", user?.id, year],
    enabled: !!user,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(`${year}-01-01`, `${year + 1}-01-01`);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["estimated-tax-payments", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchPayments(year),
  });

  const netProfitCents = entries
    ? buildStatement(
        entries.map((e) => ({
          account: e.ledger_accounts?.code ?? "__missing",
          amount_cents: e.amount_cents,
        })),
      ).netProfitCents
    : 0;

  const paidCents = payments.reduce((s, p) => s + p.paid_cents, 0);

  const estimate =
    rates && profile
      ? estimateTax({
          taxYear: year,
          netProfitCents,
          status: (profile.filing_status ??
            TAX_PROFILE_DEFAULTS.filing_status) as FilingStatus,
          rates,
          incomeTaxRateBps:
            (profile as { income_tax_rate_bps?: number | null })
              .income_tax_rate_bps ?? null,
          otherHouseholdIncomeCents: profile.other_household_income_cents,
          lastYearTotalTaxCents:
            (profile as { last_year_total_tax_cents?: number | null })
              .last_year_total_tax_cents ?? null,
          paidCents,
          preferSafeHarbour,
        })
      : null;

  const today = ymd(new Date());
  const next = nextDue(year, today);
  const periods = duePeriods(year);
  const pct = estimate ? setAsidePercent(estimate) : null;

  async function saveRate(bps: number) {
    if (!user) return;
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error } = await supabase
        .from("tax_profiles")
        .upsert({ user_id: user.id, income_tax_rate_bps: bps } as never, {
          onConflict: "user_id",
        });
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["tax-profile"] });
    } catch (err) {
      toastError(err, "Couldn't save that rate.");
    }
  }

  async function recordPayment(quarter: number) {
    if (!user) return;
    const cents = dollarInputToCents(payAmount);
    if (cents === null) {
      toast.error("Enter what you actually paid.");
      return;
    }
    try {
      await savePayment(user.id, {
        tax_year: year,
        quarter,
        paid_cents: cents,
        paid_on: today,
        note: null,
      });
      await qc.invalidateQueries({ queryKey: ["estimated-tax-payments"] });
      setPayingQuarter(null);
      setPayAmount("");
      toast.success("Recorded.");
    } catch (err) {
      toastError(err, "Couldn't record that payment.");
    }
  }

  const years = [0, 1].map((n) => new Date().getFullYear() - n);
  const loading = ratesLoading || entriesLoading;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">What to set aside</CardTitle>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            Nobody withholds tax on a flip. This is roughly what to move into a
            second account so April is not a shock.
          </p>
        </div>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger
            className="h-9 w-28"
            aria-label="Tax year for the estimate"
          >
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
      </CardHeader>

      <CardContent className="space-y-5">
        {loading || !estimate ? (
          <Skeleton className="h-48 w-full" />
        ) : netProfitCents <= 0 ? (
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            No profit recorded for {year} yet, so there is nothing to set aside.
            This fills in as sales land.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">
                {formatCents(estimate.totalCents)}
              </span>
              <span className="text-[13px] text-muted-foreground">
                for the year
                {pct !== null && ` — about ${pct.toFixed(0)}% of your profit`}
              </span>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
              <span>
                <span className="text-muted-foreground">Profit so far </span>
                <span className="tabular-nums">
                  {formatCents(netProfitCents)}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Paid </span>
                <span className="tabular-nums">{formatCents(paidCents)}</span>
              </span>
              <span>
                <span className="text-muted-foreground">
                  Still to set aside{" "}
                </span>
                <span className="font-medium tabular-nums">
                  {formatCents(estimate.shortfallCents)}
                </span>
              </span>
            </div>

            {/* AC3. Once payments exist the screen shows what is left, not the
                ideal. The ideal stops changing what anyone does. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2 text-left font-medium">Due</th>
                    <th className="p-2 text-left font-medium">Covers</th>
                    <th className="p-2 text-right font-medium">Suggested</th>
                    <th className="p-2 text-right font-medium">You paid</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => {
                    const paid = payments.find((x) => x.quarter === p.quarter);
                    const isNext = next?.quarter === p.quarter;
                    const past = p.dueOn < today;
                    return (
                      <tr
                        key={p.quarter}
                        className={cn(
                          "border-b last:border-b-0",
                          isNext && "bg-muted/40",
                        )}
                      >
                        <td className="p-2 whitespace-nowrap">
                          {p.dueOn}
                          {isNext && (
                            <span className="ml-2 text-[11px] font-medium text-brand-navy dark:text-foreground">
                              next
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {p.covers}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCents(estimate.perPeriodCents)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {paid ? (
                            formatCents(paid.paid_cents)
                          ) : past ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              nothing
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          {payingQuarter === p.quarter ? (
                            <span className="flex items-center justify-end gap-1">
                              <Input
                                className="h-8 w-24"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={payAmount}
                                onChange={(e) => setPayAmount(e.target.value)}
                                autoFocus
                                aria-label={`Amount paid for the period due ${p.dueOn}`}
                              />
                              <Button
                                size="sm"
                                aria-label={`Save the payment for the period due ${p.dueOn}`}
                                onClick={() => recordPayment(p.quarter)}
                              >
                                Save
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setPayingQuarter(p.quarter);
                                setPayAmount(
                                  paid
                                    ? (paid.paid_cents / 100).toFixed(2)
                                    : "",
                                );
                              }}
                            >
                              {paid ? "Edit" : "I paid"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* AC4. An unexplained number here is worse than none: a seller who
                cannot see the assumptions cannot tell whether it applies to
                them, and will either over-save all year or find out in April
                that it did not. */}
            <div className="border-t pt-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Info className="h-4 w-4" />
                What this is built on
              </p>
              <ul className="mt-2 space-y-1.5">
                {estimate.assumptions.map((a) => (
                  <li
                    key={a}
                    className="max-w-prose text-[13px] leading-relaxed text-muted-foreground"
                  >
                    {a}
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Label htmlFor="et-rate" className="text-[13px]">
                  Income tax rate
                </Label>
                <Select
                  value={String(estimate.incomeTaxRateBps)}
                  onValueChange={(v) => saveRate(Number(v))}
                >
                  <SelectTrigger id="et-rate" className="h-8 w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RATE_CHOICES.map((r) => (
                      <SelectItem key={r.bps} value={String(r.bps)}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[13px] text-muted-foreground">
                  If reselling is your only income and you make under about
                  $48,000, 12% is usually close.
                </span>
              </div>

              {estimate.safeHarbourCents !== null && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    size="sm"
                    variant={preferSafeHarbour ? "default" : "outline"}
                    onClick={() => setPreferSafeHarbour((v) => !v)}
                  >
                    <PiggyBank className="mr-2 h-4 w-4" />
                    {preferSafeHarbour ? "Using" : "Use"} last year's tax
                    instead
                  </Button>
                  <span className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                    {formatCents(estimate.safeHarbourCents)}. Pay that and there
                    is no penalty however this year turns out, even if you end
                    up owing more.
                  </span>
                </div>
              )}
            </div>

            <p className="flex max-w-prose gap-2 text-[13px] leading-relaxed text-muted-foreground">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
              The last payment for {year} is due in January {year + 1}, not
              December. Four payments do not all fall inside the year.
            </p>

            <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              This is an estimate to plan with, not a filing and not advice.
              GradeThread does the arithmetic; what you owe depends on your
              whole return.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
