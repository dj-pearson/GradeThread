import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Award,
  Ban,
  Coins,
  CreditCard,
  FileText,
  LifeBuoy,
  Loader2,
  RefreshCcw,
  Shield,
  UserPlus,
} from "lucide-react";

// ── UserTimelineCard (US-902) ────────────────────────────────────────────────
//
// A unified, chronological "user 360" feed embedded on /admin/users/:id. Merges
// signups, submissions, grades, credit-ledger movements, FlipDesk subscription
// events, disputes, support tickets and admin actions taken against the user
// into one server-paginated timeline (GET /api/admin/users/:id/timeline). Type
// chips filter the feed; "Load more" walks the time-based cursor.

type TimelineType =
  | "signup"
  | "submission"
  | "grade"
  | "credit"
  | "subscription"
  | "dispute"
  | "ticket"
  | "admin_action";

interface TimelineEvent {
  id: string;
  type: TimelineType;
  timestamp: string;
  summary: string;
  link: string | null;
}

interface TimelinePage {
  events: TimelineEvent[];
  nextCursor: string | null;
  availableTypes: TimelineType[];
}

const TYPE_META: Record<
  TimelineType,
  { label: string; icon: typeof Activity; dot: string }
> = {
  signup: { label: "Signup", icon: UserPlus, dot: "bg-brand-navy text-white" },
  submission: { label: "Submissions", icon: FileText, dot: "bg-blue-500 text-white" },
  grade: { label: "Grades", icon: Award, dot: "bg-green-600 text-white" },
  credit: { label: "Credits", icon: Coins, dot: "bg-amber-500 text-white" },
  subscription: { label: "Subscription", icon: CreditCard, dot: "bg-purple-500 text-white" },
  dispute: { label: "Disputes", icon: AlertTriangle, dot: "bg-orange-500 text-white" },
  ticket: { label: "Support", icon: LifeBuoy, dot: "bg-cyan-600 text-white" },
  admin_action: { label: "Admin actions", icon: Shield, dot: "bg-red-500 text-white" },
};

const ALL_TYPES: TimelineType[] = [
  "signup",
  "submission",
  "grade",
  "credit",
  "subscription",
  "dispute",
  "ticket",
  "admin_action",
];

const PAGE_SIZE = 25;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface UserTimelineCardProps {
  userId: string;
}

export function UserTimelineCard({ userId }: UserTimelineCardProps) {
  // Empty set = no filter (show all). Selecting chips narrows to those types.
  const [active, setActive] = useState<Set<TimelineType>>(new Set());

  const typesParam = useMemo(
    () => (active.size > 0 ? [...active].sort().join(",") : ""),
    [active],
  );

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["admin-user-timeline", userId, typesParam],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<TimelinePage> => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) params.set("cursor", pageParam);
      if (typesParam) params.set("types", typesParam);
      const res = await edgeFetch(
        `/api/admin/users/${userId}/timeline?${params.toString()}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load timeline.");
      return json as TimelinePage;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const events = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.events),
    [data],
  );

  function toggle(type: TimelineType) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-5 w-5" />
              Activity Timeline
            </CardTitle>
            <CardDescription>
              Everything that happened on this account — signups, submissions,
              grades, credits, subscription, disputes, tickets and admin actions —
              in one chronological feed.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCcw className={cn("mr-2 h-3.5 w-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {/* Type filter chips */}
        <div className="flex flex-wrap gap-1.5 pt-2">
          {ALL_TYPES.map((t) => {
            const meta = TYPE_META[t];
            const Icon = meta.icon;
            const selected = active.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggle(t)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
                aria-pressed={selected}
              >
                <Icon className="h-3 w-3" />
                {meta.label}
              </button>
            );
          })}
          {active.size > 0 && (
            <button
              type="button"
              onClick={() => setActive(new Set())}
              className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="h-4 w-4" />
            {(error as Error)?.message ?? "Failed to load timeline."}
          </div>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No activity{active.size > 0 ? " for the selected filters" : ""} yet.
          </p>
        ) : (
          <>
            <ol className="relative space-y-5 border-l border-border pl-6">
              {events.map((ev) => {
                const meta = TYPE_META[ev.type] ?? TYPE_META.admin_action;
                const Icon = meta.icon ?? Ban;
                return (
                  <li key={ev.id} className="relative">
                    <span
                      className={cn(
                        "absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-background",
                        meta.dot,
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </span>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm">
                          {ev.link ? (
                            <a
                              href={ev.link}
                              className="font-medium text-foreground hover:text-primary hover:underline"
                            >
                              {ev.summary}
                              <ArrowUpRight className="ml-0.5 inline h-3 w-3 align-text-top" />
                            </a>
                          ) : (
                            <span className="font-medium">{ev.summary}</span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatWhen(ev.timestamp)}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {meta.label}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ol>

            {hasNextPage && (
              <div className="mt-5 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
