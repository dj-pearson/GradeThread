import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, PiggyBank } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatCents } from "@/lib/ledger-math";
import { ensureLedgerBuilt, fetchLedgerEntries } from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import { fetchReviewCount } from "@/lib/books-review";
import { fetchPayments, fetchTaxRateYear } from "@/lib/estimated-tax";
import { standingHeadline, taxRunway } from "@/lib/tax-runway";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  fiscalYearLabel,
  periodRange,
  ymd,
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
  const profileQuery = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const profile = profileQuery.data;
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
  const ledgerQuery = useQuery({
    queryKey: ["money-overview-ledger", user?.id, fiscal.from, fiscal.to],
    enabled: !!user,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(fiscal.from, fiscal.to);
    },
    staleTime: 5 * 60 * 1000,
  });

  const entries = ledgerQuery.data;
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
  const ratesQuery = useQuery({
    queryKey: ["tax-rate-year", taxYear],
    enabled: !!user,
    queryFn: () => fetchTaxRateYear(taxYear),
    staleTime: 24 * 60 * 60 * 1000,
  });
  const calendarQuery = useQuery({
    queryKey: ["money-overview-calendar", user?.id, taxYear],
    enabled: !!user,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(`${taxYear}-01-01`, `${taxYear + 1}-01-01`);
    },
    staleTime: 5 * 60 * 1000,
  });
  const paymentsQuery = useQuery({
    queryKey: ["estimated-tax-payments", user?.id, taxYear],
    enabled: !!user,
    queryFn: () => fetchPayments(taxYear),
    staleTime: 5 * 60 * 1000,
  });

  // US-3137 REPLACED estimateTax HERE, and the reason is worth keeping.
  //
  // This tile used to read `estimateTax(...).shortfallCents` on the profit made
  // so far. That treats a part-year figure as if it were the whole year, so the
  // same seller having the same year was told to set aside a small amount in
  // March and a large one in November, and neither number answered the question
  // the tile is asking. `taxRunway` splits it into what has ACCRUED (owed on
  // profit already made, no projection) and what the instalment schedule wanted
  // by a date that has passed. The headline shows whichever of the two the
  // seller can act on.
  const rates = ratesQuery.data;
  const calendarEntries = calendarQuery.data;
  const payments = paymentsQuery.data;
  const runway = useMemo(() => {
    if (!rates || !profile || !calendarEntries) return null;
    return taxRunway({
      taxYear,
      today: ymd(today),
      entries: calendarEntries.map((e) => ({
        entry_date: e.entry_date,
        account: e.ledger_accounts?.code ?? "__missing",
        amount_cents: e.amount_cents,
      })),
      profitFor: (rows) =>
        buildStatement(
          rows.map((r) => ({
            account: r.account,
            amount_cents: r.amount_cents,
          })),
        ).netProfitCents,
      status: (profile.filing_status ??
        TAX_PROFILE_DEFAULTS.filing_status) as FilingStatus,
      rates,
      incomeTaxRateBps:
        (profile as { income_tax_rate_bps?: number | null }).income_tax_rate_bps ?? null,
      otherHouseholdIncomeCents: profile.other_household_income_cents ?? null,
      lastYearTotalTaxCents:
        (profile as { last_year_total_tax_cents?: number | null })
          .last_year_total_tax_cents ?? null,
      payments: payments ?? [],
      fiscalYearStartMonth:
        profile.fiscal_year_start_month ??
        TAX_PROFILE_DEFAULTS.fiscal_year_start_month,
    });
    // `today` is a stable render-scoped Date, so it is not a dependency that
    // can change under the memo without `calendarEntries` changing too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rates, profile, calendarEntries, payments, taxYear]);

  const reviewCountQuery = useQuery({
    queryKey: ["books-review-count", user?.id, taxYear],
    enabled: !!user,
    queryFn: () => fetchReviewCount(`${taxYear}-01-01`, `${taxYear + 1}-01-01`),
    staleTime: 5 * 60 * 1000,
  });

  // US-3217. EVERY figure on this page comes from one of the six reads above,
  // and react-query leaves `data` undefined on a failure exactly as it does
  // before the first fetch. Without this branch a seller whose ledger read
  // failed is told "Profit, FY2026: $0.00 -- $0.00 came in", that their books
  // have "nothing unexplained in them", and, if the tax reads failed, to go
  // "answer five questions in Tax & filing" they answered months ago. A
  // wrong accounting figure is worse than no page.
  const moneyQueries = [
    profileQuery,
    ledgerQuery,
    ratesQuery,
    calendarQuery,
    paymentsQuery,
    reviewCountQuery,
  ];
  const readFailed = moneyQueries.some((q) => q.isError);
  const refetching = moneyQueries.some((q) => q.isFetching);

  const reviewCount = reviewCountQuery.data ?? 0;

  if (readFailed) {
    return (
      <ErrorState
        title="Couldn't load your money"
        description="One of the reads behind these figures failed, so the numbers would be wrong rather than missing. Nothing has changed in your books."
        onRetry={() => {
          for (const q of moneyQueries) void q.refetch();
        }}
        retrying={refetching}
      />
    );
  }

  if (ledgerQuery.isLoading) {
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

  const pct =
    runway?.setAsideRateBps == null ? null : runway.setAsideRateBps / 100;
  // Behind on a passed instalment date is the more urgent of the two, so it
  // wins the headline when it is non-zero. Otherwise the tile shows what has
  // accrued but not been paid, which is money that is not profit.
  const behind = (runway?.behindByCents ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* THE TWO A SELLER CAN ACT ON TODAY. AC4 puts them first, and they are
          set larger and bordered, because an identical grid of four says every
          number matters equally -- which is exactly what this page must not
          say. Emphasis by weight and size, not by colour or a gradient. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Answer
          tone="act"
          label={behind ? "Late on estimated tax" : "Set aside for tax"}
          value={
            runway
              ? formatCents(
                  behind ? runway.behindByCents : runway.holdBackCents,
                )
              : "Not set up"
          }
          detail={
            runway
              ? behind
                ? `The installment schedule wanted this by a ${taxYear} date that has already passed. ` +
                  standingHeadline(runway)
                : `Tax on the profit you have already made in ${taxYear}, less what you have paid. ` +
                  (pct == null
                    ? "It moves every time you sell."
                    : `That is about ${pct.toFixed(0)}% of your profit.`)
              : "Answer five questions in Tax & filing and this becomes a figure you can move into a second account."
          }
          to={viewLink("tax")}
          cta={runway ? "See where you stand" : "Set it up"}
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
