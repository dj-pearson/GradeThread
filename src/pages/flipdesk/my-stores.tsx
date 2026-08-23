import { useMemo, useState } from "react";
import { Link } from "react-router";
import { MapPin, Radar, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useSources } from "@/hooks/use-sources";
import {
  useLinkRadarStore,
  useRadarStores,
  type PersonalStore,
  type PersonalStoreSort,
} from "@/hooks/use-radar-stores";
import { FLIPDESK_SOURCE_TYPE_LABELS } from "@/lib/constants";
import type { FlipdeskSourceType } from "@/types/database";

// US-1864: "My stores" — the free, personal half of Thrift Radar.
//
// This page answers a question the shared map cannot answer on day one: which of
// the places YOU already buy from actually make you money. It reads only the
// reseller's own data (sources → items → sales, plus the visits their Prospect
// scans recorded), so it is useful with a single item from a single store and
// with no network data anywhere near them (rule 7,
// vault/20-domain/thrift-radar.md).
//
// Two numbers here are easy to conflate, so both are shown and labelled:
//   • Realized ROI is profit on what SOLD, over what those items cost. It is the
//     honest score of a store's finished business.
//   • Blended ROI folds in what unsold stock is EXPECTED to clear, at the price
//     the reseller set themselves. It is the default sort because it is the one
//     that answers "should I drive back there", but it moves as stock ages.

const SORT_LABELS: Record<PersonalStoreSort, string> = {
  roi: "Blended ROI",
  realized_roi: "Realized ROI",
  profit: "Total profit",
  spend: "Total spend",
  items: "Items sourced",
  visits: "Visits",
  recent: "Most recent",
  name: "Name",
};

const SORT_ORDER: PersonalStoreSort[] = [
  "roi",
  "realized_roi",
  "profit",
  "spend",
  "items",
  "visits",
  "recent",
  "name",
];

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function percent(value: number | null): string {
  if (value == null) return "—";
  return `${value.toFixed(1)}%`;
}

function visitDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Positive profit reads as a gain, negative as a loss. Tinted from the surface. */
function profitTone(cents: number): string {
  if (cents > 0) return "text-green-700 dark:text-green-400";
  if (cents < 0) return "text-destructive";
  return "text-muted-foreground";
}

function sourceTypeLabel(raw: string | null): string | null {
  if (!raw) return null;
  return FLIPDESK_SOURCE_TYPE_LABELS[raw as FlipdeskSourceType] ?? raw;
}

function StoreRow({ store }: { store: PersonalStore }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex items-start gap-2">
          {store.source_id ? (
            <Store className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <Radar className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="font-medium leading-tight">{store.name}</p>
            <p className="text-xs text-muted-foreground">
              {[sourceTypeLabel(store.source_type), store.location]
                .filter(Boolean)
                .join(" · ") ||
                (store.source_id ? "No location recorded" : "Seen while scanning")}
            </p>
            {store.top_brands.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {store.top_brands.map((b) => (
                  <Badge key={b.brand} variant="outline" className="font-normal">
                    {b.brand}
                    {b.items > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        {b.items}
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        {store.items_sourced}
        {store.items_sold > 0 && (
          <span className="block text-xs text-muted-foreground">
            {store.items_sold} sold
          </span>
        )}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        {money(store.spend_cents)}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <span className={profitTone(store.realized_profit_cents)}>
          {money(store.realized_profit_cents)}
        </span>
        {store.expected_profit_cents !== 0 && (
          <span className="block text-xs text-muted-foreground">
            {money(store.expected_profit_cents)} expected
          </span>
        )}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <span className={cn(store.roi_pct != null && "font-medium")}>
          {percent(store.roi_pct)}
        </span>
        <span className="block text-xs text-muted-foreground">
          {percent(store.realized_roi_pct)} realized
        </span>
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        {store.visits > 0 ? store.visits : "—"}
        {store.buy_visits > 0 && (
          <span className="block text-xs text-muted-foreground">
            {store.buy_visits} worth buying
          </span>
        )}
      </TableCell>
      <TableCell className="text-right align-top">
        {visitDate(store.last_visit_at)}
        {store.last_visit_source && (
          <span className="block text-xs text-muted-foreground">
            {store.last_visit_source === "scan" ? "scanned" : "bought"}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * The join the personal layer needs somebody to make: this venue I keep scanning
 * at IS that store I already record purchases against.
 *
 * Offered only for venues no source has claimed. Until it is made, the venue's
 * visits and the source's money are two separate rows — which is honest, but it
 * is not the answer the reseller wants.
 */
function LinkPrompt({ venues }: { venues: PersonalStore[] }) {
  const { data: sources = [] } = useSources();
  const link = useLinkRadarStore();
  const [choice, setChoice] = useState<Record<string, string>>({});

  const unlinkedSources = useMemo(
    () => sources.filter((s) => !s.radar_venue_id),
    [sources],
  );

  if (venues.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Places you scanned at</p>
          <p className="text-sm text-muted-foreground">
            Tell us which of your sources each one is, and its visits will join
            that store&rsquo;s spend and profit instead of sitting on their own.
          </p>
        </div>
        {unlinkedSources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every source you have is already linked.{" "}
            <Link
              to="/dashboard/flipdesk/sourcing?tab=sources"
              className="underline hover:text-foreground"
            >
              Add a source
            </Link>{" "}
            to link one of these.
          </p>
        ) : (
          <div className="space-y-3">
            {venues.map((venue) => (
              <div
                key={venue.key}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{venue.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {venue.visits} visit{venue.visits === 1 ? "" : "s"} ·{" "}
                    last {visitDate(venue.last_visit_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={choice[venue.key] ?? ""}
                    onValueChange={(v) =>
                      setChoice((prev) => ({ ...prev, [venue.key]: v }))}
                  >
                    <SelectTrigger
                      className="w-56"
                      aria-label={`Source for ${venue.name}`}
                    >
                      <SelectValue placeholder="Pick one of my sources" />
                    </SelectTrigger>
                    <SelectContent>
                      {unlinkedSources.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!choice[venue.key] || link.isPending}
                    onClick={() => {
                      const sourceId = choice[venue.key];
                      if (!sourceId) return;
                      link.mutate({ sourceId, venueId: venue.venue_id });
                    }}
                    aria-label={`Link a source to ${venue.name}`}
                  >
                    Link
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FlipdeskMyStoresPage() {
  const [sort, setSort] = useState<PersonalStoreSort>("roi");
  const { data, isLoading, error } = useRadarStores(sort);

  const stores = useMemo(() => data?.stores ?? [], [data?.stores]);
  const unclaimedVenues = useMemo(
    () => stores.filter((s) => s.source_id == null && s.venue_id != null),
    [stores],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={MapPin}
        title="My stores"
        subtitle="Where your money actually came from — your own numbers, per store."
        actions={
          <Select value={sort} onValueChange={(v) => setSort(v as PersonalStoreSort)}>
            <SelectTrigger className="w-48" aria-label="Sort stores">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_ORDER.map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <p className="max-w-[70ch] text-sm text-muted-foreground">
        This is yours alone. It is built from the sources you record, the items you
        buy and what they sold for, so it works from your very first flip and does
        not need anybody else&rsquo;s scans. Contributing to the shared Radar map is
        a separate choice and does not change anything on this page.
      </p>

      {isLoading ? (
        <TableLoadingSkeleton rows={5} />
      ) : error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {error.message} — try again in a moment.
          </CardContent>
        </Card>
      ) : stores.length === 0 ? (
        <EmptyState
          icon={Store}
          title="No store history yet"
          description="Record a source and attach it to the items you buy, and this page will start ranking where your best flips come from."
          action={{
            label: "Add a source",
            to: "/dashboard/flipdesk/sourcing?tab=sources",
          }}
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                    <TableHead className="text-right">ROI</TableHead>
                    <TableHead className="text-right">Visits</TableHead>
                    <TableHead className="text-right">Last visit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stores.map((store) => (
                    <StoreRow key={store.key} store={store} />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <LinkPrompt venues={unclaimedVenues} />

          {/* Said out loud rather than left implied: a ranking that quietly
              omits part of the account reads as complete when it is not. */}
          {(data?.unattributed_items ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {data?.unattributed_items} item
              {data?.unattributed_items === 1 ? " has" : "s have"} no source, so
              they are not counted above.
            </p>
          )}
          {(data?.unplaced_visits ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {data?.unplaced_visits} scan
              {data?.unplaced_visits === 1 ? "" : "s"} could not be matched to a
              store.
            </p>
          )}
          {data?.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing your most recent history only — older items and scans are
              left out of these totals.
            </p>
          )}
        </>
      )}
    </div>
  );
}
