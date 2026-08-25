import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TruncatedNotice } from "@/components/flipdesk/truncated-notice";
import { fetchCapped } from "@/lib/paged-read";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { COMMON_TIMEZONES, detectTimezone, formatInZone } from "@/lib/scheduling";
import { cn } from "@/lib/utils";
import { DropDayDialog } from "@/components/flipdesk/drop-day-dialog";
import { PageHelp } from "@/components/help/page-help";
import { Term } from "@/components/help/term";

// US-563: a calendar view of every scheduled drop. The 5-min `publish-due`
// cron publishes drafts whose `scheduled_publish_at` is in the past, so this
// surface is the human-facing companion: see what's queued, in which timezone,
// and whether each drop carries a Promoted-Listings boost on go-live.

interface ScheduledDropRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number | null;
  scheduled_publish_at: string;
  promo_opt_out: boolean | null;
  promo_rate_pct: number | null;
}

// US-2522: how many drops a day cell shows before it collapses to "+N more".
// Four rows is what fits without the calendar row growing past the fold.
const VISIBLE_PER_DAY = 3;

// How many upcoming drops the list shows before it offers the rest.
const UPCOMING_PREVIEW = 12;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The calendar date (Y/M/D, 1-based month) an instant falls on in a given zone.
function zoneYmd(iso: string, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(iso))
    .split("-");
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function FlipdeskScheduledDropsPage() {
  const user = useAuthStore((s) => s.user);
  const [timeZone, setTimeZone] = useState(() => detectTimezone());
  // Which month the grid shows, as a {y, m} pair (m is 0-based). Seeded to the
  // current month in the viewer's zone.
  const [view, setView] = useState(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: detectTimezone(),
      year: "numeric",
      month: "2-digit",
    })
      .format(now)
      .split("-");
    return { y: Number(parts[0]), m: Number(parts[1]) - 1 };
  });

  // US-2169: `.limit(500)` rendered as if it were the whole queue meant a seller
  // with more scheduled drops than that saw a calendar quietly missing entries —
  // on the surface whose entire job is telling them what publishes when.
  // fetchCapped asks for one row past the cap so the shortfall is stated.
  const {
    data: dropsRead,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["scheduled_drops", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: () => fetchCapped<ScheduledDropRow>(async (limit) => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_price, scheduled_publish_at, promo_opt_out, promo_rate_pct",
        )
        .eq("listing_status", "draft")
        .not("scheduled_publish_at", "is", null)
        .order("scheduled_publish_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as ScheduledDropRow[];
    }),
  });
  // Memoized so the `?? []` fallback does not mint a new array each render —
  // several useMemos below take it as a dependency.
  const drops = useMemo<ScheduledDropRow[]>(() => dropsRead?.rows ?? [], [dropsRead]);

  // Titles fall back to the inventory item when listing_title is blank.
  const itemIds = useMemo(
    () => drops.map((d) => d.inventory_item_id),
    [drops],
  );
  // Key on the id CONTENTS, not the count — a length-only key serves the stale
  // title map when the set turns over without changing size.
  const itemIdsKey = useMemo(() => [...itemIds].sort().join(","), [itemIds]);
  const { data: titles = {} } = useQuery<Record<string, string>>({
    queryKey: ["scheduled_drops_titles", user?.id, itemIdsKey],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      // Chunk the id list: a single `.in("id", [...])` with hundreds of UUIDs
      // overflows the request URL length limit (ERR_FAILED on large queues) —
      // same cap the sibling listing-performance query guards against.
      const map: Record<string, string> = {};
      const CHUNK = 100;
      for (let i = 0; i < itemIds.length; i += CHUNK) {
        const { data } = await supabase
          .from("inventory_items")
          .select("id, title")
          .in("id", itemIds.slice(i, i + CHUNK));
        for (const row of (data ?? []) as { id: string; title: string | null }[]) {
          if (row.title) map[row.id] = row.title;
        }
      }
      return map;
    },
  });

  const titleOf = (d: ScheduledDropRow) =>
    d.listing_title?.trim() || titles[d.inventory_item_id] || "Untitled draft";
  const isPromoted = (d: ScheduledDropRow) =>
    !d.promo_opt_out && (d.promo_rate_pct ?? 0) > 0;

  // Bucket drops by their calendar day *in the selected timezone* so the same
  // listing lands on the right cell regardless of the viewer's browser zone.
  const dropsByDay = useMemo(() => {
    const map = new Map<string, ScheduledDropRow[]>();
    for (const d of drops) {
      const { y, m, d: day } = zoneYmd(d.scheduled_publish_at, timeZone);
      const key = `${y}-${m}-${day}`;
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return map;
  }, [drops, timeZone]);

  // Build the calendar grid: leading blanks to the first weekday, then the days.
  const grid = useMemo(() => {
    const first = new Date(Date.UTC(view.y, view.m, 1));
    const startWeekday = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
    const cells: ({ day: number; key: string } | null)[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ day, key: `${view.y}-${view.m + 1}-${day}` });
    }
    return cells;
  }, [view]);

  const today = useMemo(() => zoneYmd(new Date().toISOString(), timeZone), [timeZone]);

  // ── US-2522: the parts that make this a calendar you can act on ──────────

  // Which day's drops are open in the dialog.
  const [openDayNum, setOpenDayNum] = useState<number | null>(null);
  // The roving tabstop. One cell in the grid is focusable at a time; the arrow
  // keys move it, which is what makes a 35-cell grid traversable without 35
  // tab presses.
  const [focusedDay, setFocusedDay] = useState(1);
  const focusedCellRef = useRef<HTMLDivElement | null>(null);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);

  const daysInView = useMemo(
    () => new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate(),
    [view],
  );

  function openDay(day: number) {
    setFocusedDay(day);
    setOpenDayNum(day);
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };
    let next: number | null = null;
    if (e.key in moves) next = focusedDay + moves[e.key]!;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = daysInView;
    if (next == null) return;
    e.preventDefault();
    // Stop at the month's edges rather than wrapping — a wrap that silently
    // changes month is worse than a key that does nothing.
    setFocusedDay(Math.min(Math.max(next, 1), daysInView));
  }

  // Move real focus with the roving tabstop, or the arrow keys move a highlight
  // a screen reader never announces.
  useEffect(() => {
    focusedCellRef.current?.focus();
  }, [focusedDay]);

  const openDayDrops = useMemo(() => {
    if (openDayNum == null) return [];
    const key = `${view.y}-${view.m + 1}-${openDayNum}`;
    return (dropsByDay.get(key) ?? []).map((d) => ({
      id: d.id,
      inventory_item_id: d.inventory_item_id,
      scheduled_publish_at: d.scheduled_publish_at,
      listing_price: d.listing_price,
      // Same fallbacks as titleOf/isPromoted, inlined: both are recreated every
      // render, so depending on them would rebuild this list every render too.
      title:
        d.listing_title?.trim() || titles[d.inventory_item_id] || "Untitled draft",
      promoted: !d.promo_opt_out && (d.promo_rate_pct ?? 0) > 0,
    }));
  }, [openDayNum, view, dropsByDay, titles]);

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const next = new Date(Date.UTC(v.y, v.m + delta, 1));
      return { y: next.getUTCFullYear(), m: next.getUTCMonth() };
    });
  };

  const monthCount = useMemo(
    () =>
      drops.filter((d) => {
        const { y, m } = zoneYmd(d.scheduled_publish_at, timeZone);
        return y === view.y && m === view.m + 1;
      }).length,
    [drops, timeZone, view],
  );

  const tzOptions = COMMON_TIMEZONES.some((t) => t.id === timeZone)
    ? COMMON_TIMEZONES
    : [{ id: timeZone, label: `${timeZone} (your timezone)` }, ...COMMON_TIMEZONES];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={CalendarClock}
        title="Scheduled drops"
        subtitle={
          <>
            <Term name="Drop">Drops</Term> are listings queued to go live at peak
            times. They publish automatically within about 5 minutes of their
            scheduled time.
          </>
        }
        actions={
          <>
            <PageHelp slug="scheduling-a-drop" />
            <Button asChild variant="outline">
              <Link to="/dashboard/flipdesk/autolister?view=drafts">
                <Sparkles className="mr-2 h-4 w-4" />
                Drafts
              </Link>
            </Button>
          </>
        }
      />

      {dropsRead?.truncated && (
        <TruncatedNotice
          limit={dropsRead.limit}
          noun="scheduled drops"
          action="The soonest are shown first."
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>
                {MONTH_NAMES[view.m]} {view.y}
              </CardTitle>
              <CardDescription>
                {monthCount} drop{monthCount === 1 ? "" : "s"} this month ·{" "}
                {drops.length} scheduled total
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={timeZone} onValueChange={setTimeZone}>
                <SelectTrigger className="h-8 w-[15rem] text-xs" aria-label="Time zone">
                  <SelectValue placeholder="Timezone" />
                </SelectTrigger>
                <SelectContent>
                  {tzOptions.map((tz) => (
                    <SelectItem key={tz.id} value={tz.id} className="text-xs">
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftMonth(-1)}
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    const now = new Date();
                    const { y, m } = zoneYmd(now.toISOString(), timeZone);
                    setView({ y, m: m - 1 });
                  }}
                >
                  Today
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => shiftMonth(1)}
                  aria-label="Next month"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isError ? (
            <ErrorState
              title="Couldn't load scheduled drops"
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          ) : isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : drops.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No scheduled drops yet"
              description="Open a draft, set a peak-time preset under “Schedule publish”, and it will appear here."
            />
          ) : (
            <>
              {/* US-2522: a real grid — announced as one, traversable with
                  the arrow keys, and every day cell opens its own drops rather
                  than only linking away to a draft. */}
              <div
                role="grid"
                // The grid itself is never the focus target — one cell holds the
                // roving tabstop — but a role=grid that handles keys has to be
                // focusable for the handler to be reachable at all.
                tabIndex={-1}
                aria-label={`Scheduled drops for ${MONTH_NAMES[view.m]} ${view.y}`}
                className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border text-center text-xs font-medium text-muted-foreground"
                onKeyDown={onGridKeyDown}
              >
                <div role="row" className="contents">
                  {WEEKDAYS.map((w) => (
                    <div key={w} role="columnheader" className="bg-muted/50 py-1.5">
                      {w}
                    </div>
                  ))}
                </div>
                {grid.map((cell, i) => {
                  if (!cell) {
                    return (
                      <div
                        key={`blank-${i}`}
                        role="gridcell"
                        aria-hidden="true"
                        className="min-h-[6rem] bg-background"
                      />
                    );
                  }
                  const dayDrops = dropsByDay.get(cell.key) ?? [];
                  const isToday =
                    today.y === view.y &&
                    today.m === view.m + 1 &&
                    today.d === cell.day;
                  const shown = dayDrops.slice(0, VISIBLE_PER_DAY);
                  const hidden = dayDrops.length - shown.length;
                  return (
                    <div
                      key={cell.key}
                      role="gridcell"
                      aria-label={`${MONTH_NAMES[view.m]} ${cell.day}: ${dayDrops.length} drop${dayDrops.length === 1 ? "" : "s"}`}
                      data-day={cell.day}
                      tabIndex={cell.day === focusedDay ? 0 : -1}
                      ref={(el) => {
                        if (cell.day === focusedDay) focusedCellRef.current = el;
                      }}
                      onClick={() => dayDrops.length > 0 && openDay(cell.day)}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && dayDrops.length > 0) {
                          e.preventDefault();
                          openDay(cell.day);
                        }
                      }}
                      className={cn(
                        "min-h-[6rem] bg-background p-1 text-left align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                        dayDrops.length > 0 && "cursor-pointer hover:bg-muted/40",
                        isToday && "ring-1 ring-inset ring-brand-red",
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 text-[11px] font-semibold",
                          isToday ? "text-brand-red-text" : "text-muted-foreground",
                        )}
                      >
                        {cell.day}
                      </div>
                      <div className="space-y-1">
                        {shown.map((d) => (
                          <div
                            key={d.id}
                            className="rounded bg-brand-navy/5 px-1.5 py-1 text-[11px] leading-tight"
                            title={titleOf(d)}
                          >
                            <span className="flex items-center gap-1 font-medium text-brand-navy dark:text-blue-300">
                              {isPromoted(d) && (
                                <Megaphone className="h-3 w-3 shrink-0 text-brand-red-text" />
                              )}
                              <span className="truncate">{titleOf(d)}</span>
                            </span>
                            <span className="text-muted-foreground">
                              {new Intl.DateTimeFormat("en-US", {
                                timeZone,
                                hour: "numeric",
                                minute: "2-digit",
                              }).format(new Date(d.scheduled_publish_at))}
                              {" · "}
                              {fmtMoney(d.listing_price)}
                            </span>
                          </div>
                        ))}
                        {/* US-2522: a busy day used to render every drop and
                            grow the row past the fold. */}
                        {hidden > 0 && (
                          <span className="block px-1.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline">
                            +{hidden} more
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>


              {/* Upcoming list — a chronological companion to the grid. */}
              <div className="mt-6">
                <h2 className="mb-2 text-sm font-semibold">Upcoming</h2>
                <div className="space-y-1.5">
                  {(showAllUpcoming ? drops : drops.slice(0, UPCOMING_PREVIEW)).map((d) => (
                    <Link
                      key={d.id}
                      to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{titleOf(d)}</span>
                        {isPromoted(d) && (
                          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                            <Megaphone className="h-3 w-3" />
                            {d.promo_rate_pct}% ad
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatInZone(d.scheduled_publish_at, timeZone)}
                      </span>
                    </Link>
                  ))}
                </div>
                {/* US-2522: the list stopped dead at 12 with nothing saying
                    so, on the surface whose job is telling you what is queued. */}
                {drops.length > UPCOMING_PREVIEW && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => setShowAllUpcoming((v) => !v)}
                  >
                    {showAllUpcoming
                      ? "Show fewer"
                      : `Show all ${drops.length}`}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* US-2522: reschedule, unschedule and shift a whole day, without
          opening a single draft. */}
      <DropDayDialog
        open={openDayNum != null}
        onOpenChange={(o) => !o && setOpenDayNum(null)}
        dayLabel={`${MONTH_NAMES[view.m]} ${openDayNum}, ${view.y}`}
        drops={openDayDrops}
        timeZone={timeZone}
      />
    </div>
  );
}
