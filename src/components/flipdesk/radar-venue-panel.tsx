import { Lock, MapPin, Store, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ActivityByDay } from "@/components/flipdesk/radar-map";
import { busiestDayLabel, dayBars, freshnessLabel } from "@/lib/radar-map";
import type {
  RadarNetworkStats,
  RadarVenueDetail,
} from "@/hooks/use-radar-network";
import type { PersonalStore } from "@/hooks/use-radar-stores";

// US-1865: the venue detail panel.
//
// Every section here can be absent, and the reason is always the same one: the
// k-anonymity floor (vault/20-domain/thrift-radar.md rule 6) is enforced on the
// SERVER, and a below-floor group comes back as no row at all rather than as a
// redacted payload. So there is nothing here to hide — there is only a hole, and
// the job of this component is to say what the hole means instead of rendering
// an empty chart that reads as a finding.
//
// The honest sentence is "not enough data here yet, contributions unlock this",
// and it is deliberately the SAME sentence for a venue nobody has scanned and a
// venue two people have scanned. Distinguishing them would answer "did anyone
// scan here?", which is the exact question the floor exists to refuse.

const NOT_ENOUGH =
  "Not enough data here yet — contributions unlock this.";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Withheld({ children = NOT_ENOUGH }: { children?: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

const GRADE_BANDS = [
  { key: "high" as const, label: "8+ (great)", tone: "bg-green-600/80" },
  { key: "mid" as const, label: "6–8 (wearable)", tone: "bg-amber-500/80" },
  { key: "low" as const, label: "Under 6 (rough)", tone: "bg-muted-foreground/40" },
];

function GradeMix({ stats }: { stats: RadarNetworkStats }) {
  const mix = stats.grade_mix;
  const graded = mix.high + mix.mid + mix.low;
  if (graded === 0) {
    return (
      <Withheld>
        Nothing scanned here has been graded yet, so there is no condition
        picture to show.
      </Withheld>
    );
  }
  return (
    <div className="space-y-2">
      {GRADE_BANDS.map((band) => {
        const count = mix[band.key];
        const pct = Math.round((count / graded) * 100);
        return (
          <div key={band.key} className="space-y-1">
            <div className="flex items-baseline justify-between text-sm">
              <span>{band.label}</span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", band.tone)} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Averages {stats.avg_grade?.toFixed(1) ?? "—"} out of 10 across{" "}
        {graded} graded scan{graded === 1 ? "" : "s"}. Estimated from photos in
        the field, not a certified grade.
        {mix.ungraded > 0 && ` ${mix.ungraded} scan${mix.ungraded === 1 ? "" : "s"} had no grade.`}
      </p>
    </div>
  );
}

function BrandMix({ brands }: { brands: RadarNetworkStats[] }) {
  if (brands.length === 0) return <Withheld />;
  const peak = Math.max(...brands.map((b) => b.scan_count), 1);
  return (
    <div className="space-y-2">
      {brands.slice(0, 8).map((brand) => (
        <div key={brand.brand ?? "?"} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate capitalize">{brand.brand}</span>
            <span className="tabular-nums text-muted-foreground">
              {brand.scan_count}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand-navy dark:bg-foreground/70"
              style={{ width: `${Math.round((brand.scan_count / peak) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Only brands enough different people have scanned appear here. A brand
        missing from this list is not a brand missing from the store.
      </p>
    </div>
  );
}

export interface RadarVenuePanelProps {
  detail: RadarVenueDetail | undefined;
  isLoading: boolean;
  error: Error | null;
  /** The caller's own history at this venue, when they have any. */
  personal: PersonalStore | null;
}

export function RadarVenuePanel({
  detail,
  isLoading,
  error,
  personal,
}: RadarVenuePanelProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  // No detail at all. The endpoint gives a below-floor venue and an unknown id
  // the identical 404, so this branch cannot and must not tell them apart — but
  // the reseller's OWN history at the place is theirs regardless of the floor,
  // and is shown here at n=1.
  if (!detail) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          {personal && <PersonalSummary store={personal} />}
          <Withheld>
            {error?.message === "Not enough data here yet"
              ? "Not enough people have scanned here yet for us to say anything about this store without giving away who they were. Turning on contributions in Settings is what changes that."
              : (error?.message ?? NOT_ENOUGH)}
          </Withheld>
        </CardContent>
      </Card>
    );
  }

  const { venue, network, brands } = detail;
  const bars = dayBars(network.activity_by_day);
  const busiest = busiestDayLabel(network.activity_by_day);

  return (
    <Card>
      <CardContent className="space-y-6 p-4">
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <MapPin className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-tight">
                {venue.display_name}
              </h2>
              <p className="text-xs text-muted-foreground">
                {freshnessLabel(network.days_since_activity)}
                {venue.chain ? ` · ${venue.chain}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="font-normal">
              {network.scan_count} scan{network.scan_count === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline" className="font-normal">
              <Users className="mr-1 h-3 w-3" aria-hidden="true" />
              {network.contributor_count} people
            </Badge>
            {network.buy_rate != null && (
              <Badge variant="outline" className="font-normal">
                {Math.round(network.buy_rate * 100)}% worth buying
              </Badge>
            )}
          </div>
        </div>

        {personal && <PersonalSummary store={personal} />}

        <Section
          title="Brand mix"
          hint="What people keep finding here, by how often it was scanned."
        >
          <BrandMix brands={brands} />
        </Section>

        <Section
          title="Condition found here"
          hint="Estimated grades from field scans, not certified grades."
        >
          <GradeMix stats={network} />
        </Section>

        <Section
          title="When it is busy"
          hint={
            busiest
              ? `Most scans land on ${busiest}, in this store's local time.`
              : "Scans by day of the week, in this store's local time."
          }
        >
          {bars ? <ActivityByDay bars={bars} /> : <Withheld />}
        </Section>
      </CardContent>
    </Card>
  );
}

/**
 * The reseller's own numbers for this place.
 *
 * Free, ungated and shown even when the network layer has nothing: this is the
 * personal layer (rule 7) meeting the shared map, and it works at n=1. It sits
 * ABOVE the network sections on purpose — the question "have I done well here
 * before" outranks "are strangers busy here".
 */
function PersonalSummary({ store }: { store: PersonalStore }) {
  const money = (cents: number) =>
    `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Store className="h-3.5 w-3.5" aria-hidden="true" />
        Your history here
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {store.items_sourced > 0
          ? `${store.items_sourced} item${store.items_sourced === 1 ? "" : "s"} sourced · ${money(store.spend_cents)} spent · ${money(store.realized_profit_cents)} profit so far`
          : `${store.visits} visit${store.visits === 1 ? "" : "s"} recorded, nothing bought yet.`}
        {store.roi_pct != null && ` · ${store.roi_pct.toFixed(0)}% blended ROI`}
      </p>
    </div>
  );
}
