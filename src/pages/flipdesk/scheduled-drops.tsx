import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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

  const {
    data: drops = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["scheduled_drops", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<ScheduledDropRow[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_price, scheduled_publish_at, promo_opt_out, promo_rate_pct",
        )
        .eq("listing_status", "draft")
        .not("scheduled_publish_at", "is", null)
        .order("scheduled_publish_at", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ScheduledDropRow[];
    },
  });

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
      const { data } = await supabase
        .from("inventory_items")
        .select("id, title")
        .in("id", itemIds);
      const map: Record<string, string> = {};
      for (const row of (data ?? []) as { id: string; title: string | null }[]) {
        if (row.title) map[row.id] = row.title;
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <CalendarClock className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Scheduled drops</h1>
            <p className="text-sm text-muted-foreground">
              Listings queued to go live at peak times. They publish automatically
              within ~5 minutes of their scheduled time.
            </p>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link to="/dashboard/flipdesk/autolister/drafts">
            <Sparkles className="mr-2 h-4 w-4" />
            Drafts
          </Link>
        </Button>
      </div>

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
                <SelectTrigger className="h-8 w-[15rem] text-xs">
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
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border text-center text-xs font-medium text-muted-foreground">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="bg-muted/50 py-1.5">
                    {w}
                  </div>
                ))}
                {grid.map((cell, i) => {
                  if (!cell) {
                    return <div key={`blank-${i}`} className="min-h-[6rem] bg-background" />;
                  }
                  const dayDrops = dropsByDay.get(cell.key) ?? [];
                  const isToday =
                    today.y === view.y &&
                    today.m === view.m + 1 &&
                    today.d === cell.day;
                  return (
                    <div
                      key={cell.key}
                      className={cn(
                        "min-h-[6rem] bg-background p-1 text-left align-top",
                        isToday && "ring-1 ring-inset ring-brand-red",
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 text-[11px] font-semibold",
                          isToday ? "text-brand-red" : "text-muted-foreground",
                        )}
                      >
                        {cell.day}
                      </div>
                      <div className="space-y-1">
                        {dayDrops.map((d) => (
                          <Link
                            key={d.id}
                            to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                            className="block rounded bg-brand-navy/5 px-1.5 py-1 text-[11px] leading-tight hover:bg-brand-navy/10"
                            title={titleOf(d)}
                          >
                            <span className="flex items-center gap-1 font-medium text-brand-navy dark:text-blue-300">
                              {isPromoted(d) && (
                                <Megaphone className="h-3 w-3 shrink-0 text-brand-red" />
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
                          </Link>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Upcoming list — a chronological companion to the grid. */}
              <div className="mt-6">
                <h2 className="mb-2 text-sm font-semibold">Upcoming</h2>
                <div className="space-y-1.5">
                  {drops.slice(0, 12).map((d) => (
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
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
