import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Gauge, Layers, Tag, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  resolveCounters,
  type PublicStats,
} from "@/components/marketing/stat-counters-logic";

// US-865: live platform stat counters for the homepage + marketing pages. The
// numbers come from the aggregate-only public feed (no per-tenant data) and are
// cached hard at the edge. The strip NEVER blocks render: while loading, on
// error, or when there isn't enough data to cite a metric honestly, the whole
// section renders nothing and the page flows past it. The honesty/degradation
// logic lives in stat-counters-logic.ts (unit-tested).

const ICON_BY_KEY: Record<string, LucideIcon> = {
  agreement: Gauge,
  items_graded: Layers,
  verified_sellers: BadgeCheck,
  graded_sales: Tag,
};

function usePublicStats() {
  return useQuery<PublicStats>({
    queryKey: ["public-stats"],
    queryFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/grading/public/stats`);
      if (!res.ok) throw new Error(`Stats unavailable (${res.status})`);
      return res.json();
    },
    // These move slowly and are CDN-cached; keep them fresh for the session.
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Live social-proof counter strip. Renders nothing until there's at least one
 * citable metric, so it's safe to drop anywhere without a loading/empty state.
 */
export function StatCounters({ className }: { className?: string }) {
  const { data } = usePublicStats();
  const counters = resolveCounters(data);
  if (counters.length === 0) return null;

  return (
    <section className={cn("border-y bg-card px-6 py-10", className)}>
      <div className="mx-auto max-w-5xl">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Trusted by sellers, measured in the open
        </p>
        <dl
          className={cn(
            "mt-6 grid grid-cols-2 gap-6",
            counters.length >= 3 ? "sm:grid-cols-4" : "sm:grid-cols-2",
          )}
        >
          {counters.map((c) => {
            const Icon = ICON_BY_KEY[c.key] ?? Gauge;
            return (
              <div key={c.key} className="flex flex-col items-center text-center">
                <Icon aria-hidden="true" className="mb-2 h-5 w-5 text-brand-red" />
                <dt className="sr-only">{c.label}</dt>
                <dd className="text-3xl font-extrabold font-display tabular-nums text-brand-navy dark:text-white">
                  {c.display}
                </dd>
                <p aria-hidden="true" className="mt-1 text-xs text-muted-foreground">
                  {c.label}
                </p>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
