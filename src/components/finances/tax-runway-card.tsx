import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, TrendingUp } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/ledger-math";
import { ensureLedgerBuilt, fetchLedgerEntries } from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  ymd,
  type FilingStatus,
} from "@/lib/tax-profile";
import { fetchPayments, fetchTaxRateYear } from "@/lib/estimated-tax";
import {
  standingHeadline,
  taxRunway,
  type DatedEntry,
  type RunwayPeriod,
  type TaxRunway,
} from "@/lib/tax-runway";

// US-3137 — where the seller stands TODAY.
//
// The estimated-tax card answers "what will the year cost". This answers "am I
// level right now", which is the question that has an action attached to it in
// June. They sit next to each other and read the same ledger through the same
// statement builder, so the two can never disagree about profit.

/** The figure that leads, and the sentence that makes it trustworthy. */
function Headline({ runway }: { runway: TaxRunway }) {
  const behind = runway.standing === "behind";
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium text-muted-foreground">
        Tax owed on what you have made so far in {runway.taxYear}
      </p>
      <p className="text-3xl font-bold tracking-tight tabular-nums">
        {formatCents(runway.accruedCents)}
      </p>
      <p
        className={cn(
          "text-[13px] leading-relaxed",
          // Emphasis by weight, not by a coloured rule down the side.
          behind ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {standingHeadline(runway)}
      </p>
    </div>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

const STATE_COPY: Record<RunwayPeriod["state"], string> = {
  settled: "Covered",
  short: "Part paid",
  open: "Nothing paid",
  upcoming: "Not due yet",
};

export function TaxRunwayCard() {
  const user = useAuthStore((s) => s.user);
  const [year] = useState(() => new Date().getFullYear());
  const [showWorking, setShowWorking] = useState(false);

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

  // The SAME query key the estimated-tax card uses, so the two cards on one
  // page share a single fetch rather than racing each other for the ledger.
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

  const runway = useMemo(() => {
    if (!rates || !entries) return null;
    const dated: DatedEntry[] = entries.map((e) => ({
      entry_date: e.entry_date,
      account: e.ledger_accounts?.code ?? "__missing",
      amount_cents: e.amount_cents,
    }));
    return taxRunway({
      taxYear: year,
      today: ymd(new Date()),
      entries: dated,
      // ONE profit definition for the whole app. Passing the statement builder
      // rather than summing here is what keeps this card, the P&L and the
      // packet from becoming three answers to the same question.
      profitFor: (rows) =>
        buildStatement(
          rows.map((r) => ({ account: r.account, amount_cents: r.amount_cents })),
        ).netProfitCents,
      status: (profile?.filing_status ??
        TAX_PROFILE_DEFAULTS.filing_status) as FilingStatus,
      rates,
      incomeTaxRateBps:
        (profile as { income_tax_rate_bps?: number | null } | undefined)
          ?.income_tax_rate_bps ?? null,
      otherHouseholdIncomeCents: profile?.other_household_income_cents ?? null,
      lastYearTotalTaxCents:
        (profile as { last_year_total_tax_cents?: number | null } | undefined)
          ?.last_year_total_tax_cents ?? null,
      payments,
      fiscalYearStartMonth:
        profile?.fiscal_year_start_month ??
        TAX_PROFILE_DEFAULTS.fiscal_year_start_month,
    });
  }, [rates, entries, payments, profile, year]);

  if (ratesLoading || entriesLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!runway || !rates) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where you stand today</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            We do not have the {year} tax figures yet, so nothing here can be
            worked out. Everything else on this page still applies.
          </p>
        </CardContent>
      </Card>
    );
  }

  const rate =
    runway.setAsideRateBps == null
      ? null
      : (runway.setAsideRateBps / 100).toFixed(0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          Where you stand today
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Headline runway={runway} />

        <div className="grid gap-4 sm:grid-cols-3">
          <Figure
            label="Paid so far"
            value={formatCents(runway.paidCents)}
            detail={
              runway.paidCents === 0
                ? "No estimated payments recorded for this year."
                : "Estimated payments you recorded."
            }
          />
          <Figure
            label={runway.behindByCents > 0 ? "Late" : "Still to hold back"}
            value={formatCents(
              runway.behindByCents > 0
                ? runway.behindByCents
                : runway.holdBackCents,
            )}
            detail={
              runway.behindByCents > 0
                ? "The schedule wanted this by a date that has passed."
                : "Accrued but not paid. Not late, but it is spent money if you treat it as profit."
            }
          />
          <Figure
            label="Next payment date"
            value={runway.nextDue ? runway.nextDue.dueOn : "None left"}
            detail={
              runway.nextDue
                ? `${formatCents(runway.dueByNextDateCents)} to be level by then. Covers ${runway.nextDue.covers.toLowerCase()}.`
                : `Every ${runway.taxYear} installment date has gone.`
            }
          />
        </div>

        {rate != null && (
          <p className="text-[13px] leading-relaxed">
            That works out at <span className="font-semibold">{rate}%</span> of
            your profit. Move that share of every sale into a second account and
            this figure stays covered without you thinking about it again.
          </p>
        )}

        {/* The four periods. A table, because four rows of five numbers is a
            table, and four cards would make each row look like a decision. */}
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Period</th>
                <th className="py-2 pr-3 font-medium">Due</th>
                <th className="py-2 pr-3 text-right font-medium">Earned</th>
                <th className="py-2 pr-3 text-right font-medium">Wanted by then</th>
                <th className="py-2 pr-3 text-right font-medium">Paid</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {runway.periods.map((p) => (
                <tr key={p.quarter} className="border-b last:border-0">
                  <td className="py-2 pr-3">{p.covers}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.dueOn}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCents(p.earnedCents)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCents(p.targetThroughCents)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCents(p.paidThroughCents)}
                  </td>
                  <td
                    className={cn(
                      "py-2",
                      p.state === "open" || p.state === "short"
                        ? "font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {STATE_COPY[p.state]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[12px] leading-relaxed text-muted-foreground">
          The four periods are not equal. April to May is two months, September
          to December is four, and the last payment is due in January of the
          following year.
        </p>

        <div className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 px-2 text-[13px]"
            onClick={() => setShowWorking((v) => !v)}
            aria-expanded={showWorking}
          >
            <ChevronDown
              className={cn(
                "mr-1 h-4 w-4 transition-transform",
                showWorking && "rotate-180",
              )}
            />
            What this rests on
          </Button>
          {showWorking && (
            <ul className="space-y-1.5 pl-1">
              {runway.assumptions.map((a) => (
                <li
                  key={a}
                  className="text-[13px] leading-relaxed text-muted-foreground"
                >
                  {a}
                </li>
              ))}
              {runway.projectionBasis && (
                <li className="text-[13px] leading-relaxed text-muted-foreground">
                  If this year carries on like it has, the whole {runway.taxYear}{" "}
                  bill lands near{" "}
                  {formatCents(runway.projectedYearEndCents ?? 0)}.{" "}
                  {runway.projectionBasis}
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
            Arithmetic on your own records, federal only, no state tax. Not tax
            advice, and nothing here is filed for you.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
