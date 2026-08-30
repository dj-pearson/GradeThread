import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, PiggyBank } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/ledger-math";
import { ensureLedgerBuilt, fetchLedgerEntries } from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import { fetchReviewCount } from "@/lib/books-review";
import {
  estimateTax,
  fetchPayments,
  fetchTaxRateYear,
  setAsidePercent,
} from "@/lib/estimated-tax";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  fiscalYearLabel,
  periodRange,
  type FilingStatus,
} from "@/lib/tax-profile";
import type { MoneyView } from "@/pages/flipdesk/nav-tabs";

// US-2999 — the overview, and the reason the rebuild happened.
//
// FOUR QUESTIONS, IN THE ORDER A SELLER CAN ACT ON THEM (AC1, AC4):
//
//   1. What should I be setting aside?   -- an amount to move this week.
//   2. What needs a look?                -- a count that can reach zero.
//   3. What did I make?                  -- the year so far.
//   4. What have I spent?                -- and on what.
//
// The first two lead because they are the only two a seller can DO something
// about today. Profit and spend are the answer to "how did it go", which is
// worth knowing and cannot be acted on, so they sit under.
//
// NO ICON-TILE GRID. Four same-size cards with an icon, a heading and a line of
// text is the shape ui:check exists to refuse, and it is also the shape that
// makes every number look equally important. The first two are wide and carry a
// figure; the second two are a plain two-up.

/** A single question, answered. Never a tile. */
function Answer({
  label,
  value,
  detail,
  to,
  cta,
  tone = "plain",
}: {
  label: string;
  value: string;
  detail: string;
  to?: string;
  cta?: string;
  tone?: "plain" | "act";
}) {
  return (
    // Elevation is declared ONCE. The two cards a seller can act on take a
    // tinted border and the rest take the card's default; a border plus a wide
    // soft shadow is the tell ui:check refuses, and it would also make all four
    // read as equally urgent.
    <Card className={tone === "act" ? "border-primary/40" : undefined}>
      <CardContent className="pt-5">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <p
          className={
            tone === "act"
              ? "mt-1 text-3xl font-semibold tabular-nums tracking-tight"
              : "mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground/90"
          }
        >
          {value}
        </p>
        <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          {detail}
        </p>
        {to && cta && (
          <Link
            to={to}
            className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
          >
            {cta}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

const viewLink = (view: MoneyView, extra = "") =>
  `/dashboard/flipdesk/money?view=${view}${extra}`;

export function MoneyOverviewPage() {
  const user = useAuthStore((s) => s.user);
  const { data: profile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const startMonth =
    profile?.fiscal_year_start_month ?? TAX_PROFILE_DEFAULTS.fiscal_year_start_month;

  const today = useMemo(() => new Date(), []);
  const fiscal = useMemo(
    () => periodRange("year", startMonth, today),
    [startMonth, today],
  );
  const fiscalLabel = fiscalYearLabel(today, startMonth);

  // The ledger, once, for the whole page. Two questions read from it and a
  // third derives from those, so fetching it per card would be three copies of
  // the same answer that can disagree while they load.
  const { data: entries, isLoading: ledgerLoading } = useQuery({
    queryKey: ["money-overview-ledger", user?.id, fiscal.from, fiscal.to],
    enabled: !!user,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(fiscal.from, fiscal.to);
    },
    staleTime: 5 * 60 * 1000,
  });

  const statement = useMemo(
    () =>
      buildStatement(
        (entries ?? []).map((e) => ({
          account: e.ledger_accounts?.code ?? "__missing",
          amount_cents: e.amount_cents,
        })),
      ),
    [entries],
  );

  // Estimated tax follows the CALENDAR year, because the due dates do. This is
  // the one figure on the page that deliberately ignores the fiscal year.
  const taxYear = today.getFullYear();
  const { data: rates } = useQuery({
    queryKey: ["tax-rate-year", taxYear],
    enabled: !!user,
    queryFn: () => fetchTaxRateYear(taxYear),
    staleTime: 24 * 60 * 60 * 1000,
  });
  const { data: calendarEntries } = useQuery({
    queryKey: ["money-overview-calendar", user?.id, taxYear],
    enabled: !!user,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(`${taxYear}-01-01`, `${taxYear + 1}-01-01`);
    },
    staleTime: 5 * 60 * 1000,
  });
  const { data: payments } = useQuery({
    queryKey: ["estimated-tax-payments", user?.id, taxYear],
    enabled: !!user,
    queryFn: () => fetchPayments(taxYear),
    staleTime: 5 * 60 * 1000,
  });

  const estimate = useMemo(() => {
    if (!rates || !profile || !calendarEntries) return null;
    const calendarStatement = buildStatement(
      calendarEntries.map((e) => ({
        account: e.ledger_accounts?.code ?? "__missing",
        amount_cents: e.amount_cents,
      })),
    );
    return estimateTax({
      taxYear,
      netProfitCents: calendarStatement.netProfitCents,
      status: (profile.filing_status ??
        TAX_PROFILE_DEFAULTS.filing_status) as FilingStatus,
      rates,
      incomeTaxRateBps:
        (profile as { income_tax_rate_bps?: number | null }).income_tax_rate_bps ?? null,
      otherHouseholdIncomeCents: profile.other_household_income_cents ?? null,
      lastYearTotalTaxCents:
        (profile as { last_year_total_tax_cents?: number | null })
          .last_year_total_tax_cents ?? null,
      paidCents: (payments ?? []).reduce((s, p) => s + p.paid_cents, 0),
      preferSafeHarbour: false,
    });
  }, [rates, profile, calendarEntries, payments, taxYear]);

  const { data: reviewCount = 0 } = useQuery({
    queryKey: ["books-review-count", user?.id, taxYear],
    enabled: !!user,
    queryFn: () => fetchReviewCount(`${taxYear}-01-01`, `${taxYear + 1}-01-01`),
    staleTime: 5 * 60 * 1000,
  });

  if (ledgerLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
        <Skeleton className="h-28" />
      </div>
    );
  }

  const pct = estimate ? setAsidePercent(estimate) : null;

  return (
    <div className="space-y-4">
      {/* THE TWO A SELLER CAN ACT ON TODAY. AC4 puts them first, and they are
          set larger and bordered, because an identical grid of four says every
          number matters equally -- which is exactly what this page must not
          say. Emphasis by weight and size, not by colour or a gradient. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Answer
          tone="act"
          label="Set aside for tax"
          value={estimate ? formatCents(estimate.shortfallCents) : "Not set up"}
          detail={
            estimate
              ? `About ${pct ?? 0}% of what you make for the rest of ${taxYear}. ` +
                "This is an estimate from your own numbers, not advice."
              : "Answer five questions in Tax & filing and this becomes a figure you can move into a second account."
          }
          to={viewLink("tax")}
          cta={estimate ? "See how it is worked out" : "Set it up"}
        />
        <Answer
          tone={reviewCount > 0 ? "act" : "plain"}
          label="Needs a look"
          value={reviewCount === 0 ? "Nothing" : String(reviewCount)}
          detail={
            reviewCount === 0
              ? "Your books have nothing unexplained in them for this year."
              : "Things that would make a number wrong on your return. Each one says what it costs to leave alone."
          }
          to={reviewCount > 0 ? viewLink("pnl") : undefined}
          cta={reviewCount > 0 ? "Go through them" : undefined}
        />
      </div>

      {/* And the two that report rather than ask. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Answer
          label={`Profit, ${fiscalLabel}`}
          value={formatCents(statement.netProfitCents)}
          detail={
            `${formatCents(statement.netRevenueCents)} came in, ` +
            `${formatCents(Math.abs(statement.cogsCents))} was what the items cost you, ` +
            `${formatCents(Math.abs(statement.operatingExpensesCents))} was running the business.`
          }
          to={viewLink("pnl")}
          cta="See the statement"
        />
        <Answer
          label="Spent on running the business"
          value={formatCents(Math.abs(statement.operatingExpensesCents))}
          detail="Everything that is not the cost of the items themselves: fees, postage, supplies, software."
          to={viewLink("expenses")}
          cta="See where it went"
        />
      </div>

      {reviewCount > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
              Everything above is worked out from your books as they stand. The{" "}
              {reviewCount} item{reviewCount === 1 ? "" : "s"} on the review list
              will move these numbers once you answer them.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <PiggyBank className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
            GradeThread does the arithmetic on your own records. It does not give
            tax advice and does not file anything.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
