import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Clock, ShieldCheck, TrendingDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRepricingSuggestions } from "@/hooks/use-repricing";
import {
  useFlipdeskOverview,
  OVERVIEW_AGING_DAYS,
  type OverviewStaleRow,
} from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import { fmtMoney, PREVIEW_ROWS } from "@/lib/flipdesk-overview-format";
import {
  EmptyList,
  ListIntro,
  MetricsUnavailable,
  ShowAllToggle,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-151 + US-859, on the board (US-3076): listings live for two weeks that
// nobody is watching, each with the one thing to do about it.
//
// A snapshot, so the frame says "right now". The dismissal key is unchanged
// from when this lived in overview.tsx: a seller who already waved a nudge away
// must not get it back because the markup moved to another file.

/** US-859: dismissed nudges, per browser, keyed by item id. */
const STALE_NUDGE_DISMISS_KEY = "gt:flipdesk:stale-nudge-dismissed";

function readDismissedNudges(): Set<string> {
  try {
    const raw = localStorage.getItem(STALE_NUDGE_DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function useDismissedStaleNudges() {
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissedNudges);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(STALE_NUDGE_DISMISS_KEY, JSON.stringify([...next]));
      } catch {
        // Best-effort; still hidden for this session.
      }
      return next;
    });
  }, []);

  return { dismissed, dismiss };
}

export function FlipdeskStaleWidget({ range }: WidgetProps) {
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  // Reuse the existing repricing suggestions where available so a graded item's
  // nudge can show a concrete recommendation. Failure here is non-fatal: the
  // nudge falls back to the generic reprice/relist prompt.
  const { data: repriceSuggestions = [] } = useRepricingSuggestions();
  const repriceByItem = new Map<string, string>();
  for (const s of repriceSuggestions) {
    if (s.reason_code === "OK") continue;
    if (!repriceByItem.has(s.inventory_item_id)) {
      repriceByItem.set(s.inventory_item_id, s.message);
    }
  }

  const { dismissed: dismissedNudges, dismiss: dismissNudge } =
    useDismissedStaleNudges();

  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [range]);

  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  const rows = metrics?.staleListings ?? [];
  const count = metrics?.staleCount ?? 0;

  return (
    <div>
      <ListIntro
        note={`Active > ${OVERVIEW_AGING_DAYS} days with zero watchers`}
        count={isLoading ? undefined : count}
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard/flipdesk/analytics/performance">
              Performance
              <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      {rows.length === 0 ? (
        <EmptyList>
          {isLoading
            ? "Counting..."
            : "No stale listings. Everything's getting eyes."}
        </EmptyList>
      ) : (
        <>
          <ul className="space-y-2 text-sm">
            {(showAll ? rows : rows.slice(0, PREVIEW_ROWS)).map((row) => (
              <li
                key={row.id}
                className="space-y-2 rounded-md border p-2 hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/dashboard/flipdesk/items/${row.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {row.item_title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {fmtMoney(row.list_price)}
                      {row.brand ? ` · ${row.brand}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {row.days}d listed
                  </div>
                </div>
                {!dismissedNudges.has(row.id) && (
                  <StaleNudge
                    row={row}
                    repriceMessage={repriceByItem.get(row.id) ?? null}
                    onDismiss={() => dismissNudge(row.id)}
                  />
                )}
              </li>
            ))}
          </ul>
          <ShowAllToggle
            shown={rows.length}
            total={count || rows.length}
            expanded={showAll}
            onToggle={() => setShowAll((v) => !v)}
            noun="stale listings"
          />
        </>
      )}
    </div>
  );
}

// US-859: the actionable nudge on a stale listing. Ungraded items get a "grade
// to boost trust" prompt into that item's grading flow; already-graded items
// get a reprice/relist prompt (preferring a concrete repricing suggestion when
// one exists). Dismissible via the X, persisted per browser by the caller.
function StaleNudge({
  row,
  repriceMessage,
  onDismiss,
}: {
  row: OverviewStaleRow;
  repriceMessage: string | null;
  onDismiss: () => void;
}) {
  const isGraded = row.grade_value != null;

  const icon = isGraded ? (
    <TrendingDown
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy dark:text-foreground"
      aria-hidden="true"
    />
  ) : (
    <ShieldCheck
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy dark:text-foreground"
      aria-hidden="true"
    />
  );

  const text = isGraded
    ? (repriceMessage ??
      "No watchers in 2+ weeks — drop the price or relist to get fresh eyes.")
    : "Grade this item to add a verified condition badge + certificate — graded listings earn more buyer trust.";

  const cta = isGraded
    ? { label: "Reprice", to: "/dashboard/flipdesk/pricing?tab=repricing" }
    : {
        label: "Grade it",
        to: `/dashboard/flipdesk/items/${row.id}#canvas-grading`,
      };

  return (
    <div className="flex items-start gap-2 rounded-md border border-brand-navy/30 bg-brand-navy/5 px-2.5 py-2">
      {icon}
      <p className="flex-1 text-xs text-foreground">{text}</p>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" asChild>
          <Link to={cta.to}>
            {cta.label}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          onClick={onDismiss}
          aria-label="Dismiss nudge"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
