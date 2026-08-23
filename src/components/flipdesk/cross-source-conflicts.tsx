import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Flag,
  GitMerge,
  Loader2,
  Mail,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useConflictThreshold,
  useResolveConflicts,
  useSetConflictThreshold,
  useSyncConflicts,
  type ConflictSource,
  type SyncConflict,
} from "@/hooks/use-sync-conflicts";

// Cross-source reconciliation tab (US-148): per-listing 3-column diff
// (FlipDesk · eBay · Sheets) for price, quantity, status, and title.
// Picking a cell resolves that field to that source; per-listing and
// multi-select bulk actions accept every field from one source at once.

const FIELD_LABELS: Record<SyncConflict["field_name"], string> = {
  price: "Price",
  quantity: "Quantity",
  listing_status: "Status",
  title: "Title",
};

const SOURCE_LABELS: Record<ConflictSource, string> = {
  flipdesk: "FlipDesk",
  ebay: "eBay",
  sheets: "Sheets",
};

const SOURCES: ConflictSource[] = ["flipdesk", "ebay", "sheets"];

function valueOf(c: SyncConflict, source: ConflictSource): string | null {
  if (source === "flipdesk") return c.flipdesk_value;
  if (source === "ebay") return c.ebay_value;
  return c.sheets_value;
}

function fmtValue(c: SyncConflict, source: ConflictSource): string {
  const v = valueOf(c, source);
  if (v === null || v === "") return "—";
  if (c.field_name === "price") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : v;
  }
  return v;
}

interface ListingGroup {
  listingId: string;
  title: string;
  listingUrl: string | null;
  conflicts: SyncConflict[];
}

export function CrossSourceConflicts() {
  const { data, isLoading } = useSyncConflicts();
  const resolve = useResolveConflicts();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = useMemo<ListingGroup[]>(() => {
    const byListing = new Map<string, ListingGroup>();
    for (const c of data?.conflicts ?? []) {
      const g = byListing.get(c.listing_id) ?? {
        listingId: c.listing_id,
        title: c.listing_title ?? c.item_title ?? "Untitled listing",
        listingUrl: c.listing_url,
        conflicts: [],
      };
      g.conflicts.push(c);
      byListing.set(c.listing_id, g);
    }
    return [...byListing.values()];
  }, [data]);

  function toggleSelected(listingId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(listingId)) next.delete(listingId);
      else next.add(listingId);
      return next;
    });
  }

  async function resolveConflicts(
    entries: Array<{ conflict_id: string; source: ConflictSource }>,
  ) {
    if (entries.length === 0) return;
    try {
      await resolve.mutateAsync({ resolutions: entries });
      // Drop selections whose listings no longer have open conflicts — the
      // refetch will rebuild groups; clearing avoids stale ids lingering.
      setSelected(new Set());
    } catch {
      /* surfaced by the hook's onError toast */
    }
  }

  // "Accept all from X" entries for a set of listings — only conflicts where
  // that source actually has a value.
  function bulkEntries(
    listingIds: Iterable<string>,
    source: ConflictSource,
  ): Array<{ conflict_id: string; source: ConflictSource }> {
    const ids = new Set(listingIds);
    return (data?.conflicts ?? [])
      .filter((c) => ids.has(c.listing_id) && valueOf(c, source) !== null)
      .map((c) => ({ conflict_id: c.id, source }));
  }

  const busy = resolve.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <GitMerge className="h-4 w-4" />
                Cross-source conflicts
              </CardTitle>
              <CardDescription>
                Where FlipDesk, eBay, and your Google Sheet disagree on a
                listing. Pick the value that should win — your choice is
                remembered per field, so future syncs won&apos;t overwrite it.
              </CardDescription>
            </div>
            <Badge variant={groups.length > 0 ? "destructive" : "outline"}>
              {data?.total ?? 0}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 p-2">
              <span className="text-xs font-medium">
                {selected.size} listing{selected.size === 1 ? "" : "s"} selected
                — accept all from:
              </span>
              {SOURCES.map((source) => {
                const entries = bulkEntries(selected, source);
                return (
                  <Button
                    key={source}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy || entries.length === 0}
                    onClick={() => void resolveConflicts(entries)}
                  >
                    {SOURCE_LABELS[source]}
                    {entries.length > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        ({entries.length})
                      </span>
                    )}
                  </Button>
                );
              })}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Loading conflicts…
            </div>
          ) : groups.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              No open conflicts. FlipDesk, eBay, and Sheets agree.
            </div>
          ) : (
            groups.map((group) => (
              <ListingConflictCard
                key={group.listingId}
                group={group}
                selected={selected.has(group.listingId)}
                onToggleSelected={() => toggleSelected(group.listingId)}
                busy={busy}
                onResolve={resolveConflicts}
                bulkEntries={(source) => bulkEntries([group.listingId], source)}
              />
            ))
          )}

          {data?.has_more && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the first {data.showing} of {data.total} conflicts —
              resolve some to load more.
            </p>
          )}
        </CardContent>
      </Card>

      <ThresholdCard />
    </div>
  );
}

function ListingConflictCard({
  group,
  selected,
  onToggleSelected,
  busy,
  onResolve,
  bulkEntries,
}: {
  group: ListingGroup;
  selected: boolean;
  onToggleSelected: () => void;
  busy: boolean;
  onResolve: (
    entries: Array<{ conflict_id: string; source: ConflictSource }>,
  ) => Promise<void>;
  bulkEntries: (
    source: ConflictSource,
  ) => Array<{ conflict_id: string; source: ConflictSource }>;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-brand-navy"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select ${group.title}`}
          />
          <span className="truncate text-sm font-medium">{group.title}</span>
          {group.listingUrl && (
            <a
              href={group.listingUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Open listing"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Accept all
          </span>
          {SOURCES.map((source) => {
            const entries = bulkEntries(source);
            return (
              <Button
                key={source}
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={busy || entries.length === 0}
                onClick={() => void onResolve(entries)}
              >
                {SOURCE_LABELS[source]}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="divide-y">
        {/* Column header */}
        <div className="grid grid-cols-[5.5rem_1fr_1fr_1fr] gap-2 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <div>Field</div>
          {SOURCES.map((s) => (
            <div key={s}>{SOURCE_LABELS[s]}</div>
          ))}
        </div>

        {group.conflicts.map((c) => (
          <div key={c.id} className="px-3 py-2">
            <div className="grid grid-cols-[5.5rem_1fr_1fr_1fr] items-center gap-2">
              <div className="text-xs font-medium">
                {FIELD_LABELS[c.field_name]}
              </div>
              {SOURCES.map((source) => {
                const hasValue = valueOf(c, source) !== null;
                return (
                  <button
                    key={source}
                    type="button"
                    disabled={busy || !hasValue}
                    onClick={() =>
                      void onResolve([{ conflict_id: c.id, source }])
                    }
                    title={
                      hasValue
                        ? `Use the ${SOURCE_LABELS[source]} value`
                        : `${SOURCE_LABELS[source]} has no value for this field`
                    }
                    className={cn(
                      "truncate rounded border px-2 py-1 text-left text-xs tabular-nums transition-colors",
                      hasValue
                        ? "hover:border-brand-navy hover:bg-brand-navy/5"
                        : "cursor-default border-dashed text-muted-foreground",
                    )}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      fmtValue(c, source)
                    )}
                  </button>
                );
              })}
            </div>

            {c.suggested_action === "mark_ended_in_flipdesk" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1">
                <Flag className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  eBay says this listing ended, but FlipDesk still has it
                  active.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  disabled={busy}
                  aria-label={`Mark ${group.title} ended in FlipDesk`}
                  onClick={() =>
                    void onResolve([{ conflict_id: c.id, source: "ebay" }])
                  }
                >
                  Mark ended in FlipDesk
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Email-alert threshold: one email per upward crossing of the open-conflict
// count. Blank = disabled.
function ThresholdCard() {
  const { data: threshold, isLoading } = useConflictThreshold();
  const setThreshold = useSetConflictThreshold();
  const [draft, setDraft] = useState<string | null>(null);

  const current = threshold == null ? "" : String(threshold);
  const value = draft ?? current;
  const dirty = draft !== null && draft !== current;

  function save() {
    const trimmed = value.trim();
    if (trimmed === "") {
      setThreshold.mutate({ threshold: null });
      setDraft(null);
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setThreshold.mutate({ threshold: n });
    setDraft(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Conflict email alerts
        </CardTitle>
        <CardDescription>
          Get one email when your open conflict count reaches this number.
          Leave blank to turn alerts off.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Conflict email alert threshold"
          type="number"
          min={1}
          className="w-28"
          placeholder="Off"
          value={value}
          disabled={isLoading}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || setThreshold.isPending}
        >
          {setThreshold.isPending ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : null}
          Save
        </Button>
        {threshold == null && !isLoading && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3" />
            Alerts are currently off.
          </span>
        )}
      </CardContent>
    </Card>
  );
}
