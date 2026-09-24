import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, PiggyBank, Users } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useMoneyFiscalYear } from "@/hooks/use-money-fiscal-year";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { LedgerDriftBanner } from "@/components/finances/ledger-drift-banner";
import { formatCents } from "@/lib/ledger-math";
import {
  ensureLedgerBuilt,
  fetchLedgerEntries,
  ledgerEntriesKey,
} from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import { fetchReviewCount } from "@/lib/books-review";
import { fetchPayments, fetchTaxRateYear } from "@/lib/estimated-tax";
import { standingHeadline, taxRunway } from "@/lib/tax-runway";
import {
  TAX_PROFILE_DEFAULTS,
  fiscalYearLabel,
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

/**
 * One card's own loading or failed state. Each card waits on, and fails on,
 * only the reads it is built from, so a slow review count cannot print
 * "Nothing" and a failed rates read cannot blank the profit figure.
 */
function AnswerStatus({
  label,
  failed,
  what,
  onRetry,
  retrying,
}: {
  label: string;
  failed: boolean;
  what: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {failed ? (
          <div role="alert" className="mt-2 space-y-2">
            <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              Couldn&apos;t load {what}, so there is no figure here rather than
              a wrong one.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={retrying}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div aria-busy="true" aria-label={`Loading ${label}`}>
            <Skeleton className="mt-2 h-8 w-28" />
            <Skeleton className="mt-2 h-4 w-full max-w-sm" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type QueryLike = {
  isError: boolean;
  isSuccess: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

function gate(queries: QueryLike[]) {
  return {
    ok: queries.every((q) => q.isSuccess),
    failed: queries.some((q) => q.isError),
    retrying: queries.some((q) => q.isFetching),
    retry: () => {
      for (const q of queries) if (q.isError) void q.refetch();
    },
  };
}

const viewLink = (view: MoneyView, extra = "") =>
  `/dashboard/flipdesk/money?view=${view}${extra}`;

export function MoneyOverviewPage() {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  // Every read below is owner-only: the ledger, the tax profile and the review
  // count all answer for auth.uid(). A member acting in someone else's
  // workspace would be shown their OWN empty books as "$0 profit", so the
  // page says whose books these are instead of printing a figure.
  const actingForOwner =
    !!user && !!workspaceOwnerId && workspaceOwnerId !== user.id;
  const enabled = !!user && !actingForOwner;

  const { profileQuery, startMonth, today, fiscal } = useMoneyFiscalYear();
  const profile = profileQuery.data;
  const fiscalLabel = fiscalYearLabel(today, startMonth);

  // The ledger, once, for the whole page. Two questions read from it and a
  // third derives from those, so fetching it per card would be three copies of
  // the same answer that can disagree while they load.
  const ledgerQuery = useQuery({
    queryKey: ledgerEntriesKey(user?.id, fiscal.from, fiscal.to),
    enabled,
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
    enabled,
    queryFn: () => fetchTaxRateYear(taxYear),
    staleTime: 24 * 60 * 60 * 1000,
  });
  // For a calendar-year seller the calendar range IS the fiscal range, so the
  // key below is the same key as ledgerQuery's and react-query answers both
  // from one request. Only a non-calendar fiscal year makes a second read.
  const calFrom = `${taxYear}-01-01`;
  const calTo = `${taxYear + 1}-01-01`;
  const calendarQuery = useQuery({
    queryKey: ledgerEntriesKey(user?.id, calFrom, calTo),
    enabled,
    queryFn: async () => {
      await ensureLedgerBuilt();
      return fetchLedgerEntries(calFrom, calTo);
    },
    staleTime: 5 * 60 * 1000,
  });
  const paymentsQuery = useQuery({
    queryKey: ["estimated-tax-payments", user?.id, taxYear],
    enabled,
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
  }, [rates, profile, calendarEntries, payments, taxYear, today]);

  // The same fiscal range the P&L lists, so "Needs a look: 3" here, the tab
  // badge and the list under the statement are one count. Waits for the
  // profile so it is not first asked for the calendar year and then again.
  const reviewCountQuery = useQuery({
    queryKey: ["books-review-count", user?.id, fiscal.from, fiscal.to],
    enabled: enabled && profileQuery.isSuccess,
    queryFn: () => fetchReviewCount(fiscal.from, fiscal.to),
    staleTime: 5 * 60 * 1000,
  });

  // US-3217, narrowed. react-query leaves `data` undefined on a failure exactly
  // as it does before the first fetch, so every card is gated on the reads it
  // is built from: a pending read is a skeleton and a failed one says so. Only
  // the ledger failing blanks the whole page, because Profit and Spent both
  // come from it and there is nothing left to show.
  const taxGate = gate([profileQuery, ratesQuery, calendarQuery, paymentsQuery]);
  const reviewGate = gate([reviewCountQuery]);

  const reviewCount = reviewCountQuery.data ?? 0;

  if (actingForOwner) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-start gap-3 py-5">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              Money shows the account owner&apos;s books.
            </p>
            <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              Profit, tax and the review list are worked out from the owner&apos;s
              own ledger, which only they can open. Nothing here is shown as
              $0, because it would be your empty books rather than theirs.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (ledgerQuery.isError) {
    return (
      <ErrorState
        title="Couldn't load your money"
        description="The ledger read behind these figures failed, so the numbers would be wrong rather than missing. Nothing has changed in your books."
        onRetry={() => void ledgerQuery.refetch()}
        retrying={ledgerQuery.isFetching}
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
      {/* money.md action 6. First, because every figure below is read from
          the ledger this says is behind. Renders nothing when it agrees. */}
      <LedgerDriftBanner periodStart={fiscal.from} periodEnd={fiscal.to} />

      {/* THE TWO A SELLER CAN ACT ON TODAY. AC4 puts them first, and they are
          set larger and bordered, because an identical grid of four says every
          number matters equally -- which is exactly what this page must not
          say. Emphasis by weight and size, not by colour or a gradient. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {!taxGate.ok ? (
          <AnswerStatus
            label="Set aside for tax"
            failed={taxGate.failed}
            what="your tax setup"
            onRetry={taxGate.retry}
            retrying={taxGate.retrying}
          />
        ) : runway ? (
          <Answer
            tone="act"
            label={behind ? "Late on estimated tax" : "Set aside for tax"}
            value={formatCents(
              behind ? runway.behindByCents : runway.holdBackCents,
            )}
            detail={
              behind
                ? `The installment schedule wanted this by a ${taxYear} date that has already passed. ` +
                  standingHeadline(runway)
                : `Tax on the profit you have already made in ${taxYear}, less what you have paid. ` +
                  (pct == null
                    ? "It moves every time you sell."
                    : `That is about ${pct.toFixed(0)}% of your profit.`)
            }
            to={viewLink("tax")}
            cta="See where you stand"
          />
        ) : !profile ? (
          // Only a profile read that SUCCEEDED and came back empty is "not set
          // up". A pending or failed one is handled above.
          <Answer
            tone="act"
            label="Set aside for tax"
            value="Not set up"
            detail="Answer five questions in Tax & filing and this becomes a figure you can move into a second account."
            to={viewLink("tax")}
            cta="Set it up"
          />
        ) : (
          <Answer
            tone="act"
            label="Set aside for tax"
            value="No rates yet"
            detail={`The ${taxYear} tax rates aren't loaded yet, so there is no figure to set aside. Your setup is saved.`}
            to={viewLink("tax")}
            cta="See where you stand"
          />
        )}
        {!reviewGate.ok ? (
          <AnswerStatus
            label="Needs a look"
            failed={reviewGate.failed}
            what="your review list"
            onRetry={reviewGate.retry}
            retrying={reviewGate.retrying}
          />
        ) : (
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
        )}
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

      {reviewGate.ok && reviewCount > 0 && (
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
