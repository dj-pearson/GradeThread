import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Clock,
  RefreshCw,
  Check,
  X,
  ExternalLink,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  useRepricingSuggestions,
  useScanRepricing,
  useApplyReprice,
  useBulkRepriceApply,
  useDismissReprice,
  useRepriceRules,
  useRunRepriceRules,
  useCreateRepriceRule,
  useUpdateRepriceRule,
  useDeleteRepriceRule,
  useRepriceActions,
  ruleToInput,
  type ReasonCode,
  type RepriceRule,
  type RepriceRuleInput,
  type RepriceSuggestion,
} from "@/hooks/use-repricing";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Term } from "@/components/help/term";

// US-2171: the queue can carry dozens of nudges. Paginate the client-side list
// so the page renders a bounded slice, and let the reseller filter/sort/bulk-act
// on the whole queue instead of one Apply click per row.
const PAGE_SIZE = 20;

// The reason codes a nudge can actually carry as an actionable suggestion. OK /
// NO_COMPS never reach the queue, so they're not offered as filters.
const FILTERABLE_REASONS: ReasonCode[] = ["UNDERPRICED", "OVERPRICED", "STALE"];

type ReasonFilter = ReasonCode | "ALL";
type SortKey = "delta_desc" | "delta_asc";

// Signed price delta in cents (positive = a raise, negative = a drop).
function repriceDelta(s: RepriceSuggestion): number {
  return s.suggested_price_cents - s.current_price_cents;
}

const REASON_META: Record<
  ReasonCode,
  { label: string; icon: typeof TrendingUp; classes: string }
> = {
  UNDERPRICED: {
    label: "Underpriced",
    icon: TrendingUp,
    classes: "bg-green-100 text-green-800 border-green-200 dark:bg-green-950/50 dark:text-green-300 dark:border-green-800",
  },
  OVERPRICED: {
    label: "Overpriced",
    icon: TrendingDown,
    classes: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  },
  STALE: {
    label: "Stale",
    icon: Clock,
    classes: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800",
  },
  OK: { label: "OK", icon: Check, classes: "bg-muted text-muted-foreground" },
  NO_COMPS: { label: "No comps", icon: X, classes: "bg-muted text-muted-foreground" },
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function SuggestionRow({
  s,
  selected,
  onToggleSelect,
}: {
  s: RepriceSuggestion;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const confirm = useConfirm();
  const apply = useApplyReprice();
  const dismiss = useDismissReprice();
  const meta = REASON_META[s.reason_code] ?? REASON_META.OK;
  const Icon = meta.icon;
  const up = s.suggested_price_cents >= s.current_price_cents;

  async function onApply() {
    const ok = await confirm({
      title: "Apply this new price?",
      description: `Reprice "${s.inventory_items?.title ?? "this item"}" from ${money(
        s.current_price_cents,
      )} to ${money(s.suggested_price_cents)}. This updates the live eBay listing.`,
      confirmLabel: "Apply new price",
    });
    if (!ok) return;
    apply.mutate(s.id);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(s.id)}
          aria-label={`Select ${s.inventory_items?.title ?? "item"} for bulk repricing`}
          className="mt-1 sm:mt-0"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </Badge>
            {s.inventory_items?.grade_label && (
              <Badge variant="outline" className="text-xs">
                {s.inventory_items.grade_label}
                {s.inventory_items.grade_value != null &&
                  ` · ${s.inventory_items.grade_value.toFixed(1)}`}
              </Badge>
            )}
            <span className="truncate font-medium">
              {s.inventory_items?.title ?? "Untitled item"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{s.message}</p>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground line-through">
              {money(s.current_price_cents)}
            </span>
            <span className={cn("font-semibold", up ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400")}>
              {money(s.suggested_price_cents)}
            </span>
            <span className="text-xs text-muted-foreground">
              · {s.comp_count} comps
              {s.comp_median_cents != null && ` · median ${money(s.comp_median_cents)}`}
            </span>
            {s.listings?.listing_url && (
              <a
                href={s.listings.listing_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-navy hover:underline dark:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                view
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button
            size="sm"
            onClick={onApply}
            disabled={apply.isPending}
          >
            {apply.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-4 w-4" />
            )}
            Apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              dismiss.mutate(s.id, {
                onSuccess: () => toast.success("Suggestion dismissed."),
              })
            }
            disabled={dismiss.isPending}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// US-2171 AC4: a compact one-line summary of a rule's markdown behaviour.
function ruleSummary(r: RepriceRule): string {
  const parts = [`Drop ${r.drop_pct}% every ${r.interval_days}d`];
  if (r.filter_brand) parts.push(r.filter_brand);
  if (r.min_age_days > 0) parts.push(`${r.min_age_days}d+ old`);
  if (r.floor_price_cents != null) parts.push(`floor ${money(r.floor_price_cents)}`);
  // US-9205: say which rules may move a price the seller set by hand.
  parts.push(r.override_manual ? "may move hand-set prices" : "skips hand-set prices");
  return parts.join(" · ");
}

// US-2171 AC4: surface the previously server-only repricing rules and let the
// seller run them on demand. Create/edit/delete remain a follow-up.
// US-2171 AC4: create a markdown rule from the page (the POST /rules endpoint
// was server-only). Kept to the fields normalizeRuleInput accepts; the server
// re-validates, so this only needs to send a sane shape.
function CreateRuleDialog() {
  const create = useCreateRepriceRule();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dropPct, setDropPct] = useState("10");
  const [intervalDays, setIntervalDays] = useState("14");
  const [brand, setBrand] = useState("");
  const [minAge, setMinAge] = useState("0");
  const [floor, setFloor] = useState("");
  // US-9205 AC4: off by default. A price the seller typed is theirs.
  const [overrideManual, setOverrideManual] = useState(false);

  function reset() {
    setOverrideManual(false);
    setName("");
    setDropPct("10");
    setIntervalDays("14");
    setBrand("");
    setMinAge("0");
    setFloor("");
  }

  function submit() {
    const drop = Number(dropPct);
    const interval = Number(intervalDays);
    if (!name.trim()) return toast.error("Give the rule a name.");
    if (!Number.isFinite(drop) || drop <= 0) return toast.error("Drop % must be a positive number.");
    if (!Number.isFinite(interval) || interval <= 0) return toast.error("Interval (days) must be a positive number.");
    const floorDollars = Number(floor);
    const input: RepriceRuleInput = {
      name: name.trim(),
      enabled: true,
      inventory_item_id: null,
      filter_brand: brand.trim() || null,
      filter_category_id: null,
      min_age_days: Math.max(0, Math.trunc(Number(minAge) || 0)),
      drop_pct: drop,
      interval_days: Math.trunc(interval),
      floor_price_cents:
        floor.trim() !== "" && Number.isFinite(floorDollars) && floorDollars >= 0
          ? Math.round(floorDollars * 100)
          : null,
      auto_accept_confidence: null,
      override_manual: overrideManual,
    };
    create.mutate(input, {
      onSuccess: () => {
        toast.success("Rule created.");
        reset();
        setOpen(false);
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" /> New rule
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New repricing rule</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Age out winter coats"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rule-drop">Drop %</Label>
              <Input
                id="rule-drop"
                type="number"
                min="1"
                value={dropPct}
                onChange={(e) => setDropPct(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-interval">Every N days</Label>
              <Input
                id="rule-interval"
                type="number"
                min="1"
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rule-age">Only if older than (days)</Label>
              <Input
                id="rule-age"
                type="number"
                min="0"
                value={minAge}
                onChange={(e) => setMinAge(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-floor">Price floor ($, optional)</Label>
              <Input
                id="rule-floor"
                type="number"
                min="0"
                step="0.01"
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-brand">Brand filter (optional)</Label>
            <Input
              id="rule-brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="All brands"
            />
          </div>
          <div className="flex items-start gap-2 text-sm">
            <Checkbox
              id="rule-override-manual"
              checked={overrideManual}
              onCheckedChange={(v) => setOverrideManual(v === true)}
            />
            <div>
              <Label htmlFor="rule-override-manual">May move prices I set by hand</Label>
              <p className="text-xs text-muted-foreground">
                Off means the rule skips any listing whose price you typed over the graded price.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Create rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// US-2171 AC4: the /rules/actions audit feed — what the automation actually did.
function RepriceActionsFeed() {
  const { data: actions = [] } = useRepriceActions();
  if (actions.length === 0) return null;
  return (
    <div className="mt-3 border-t pt-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        Recent automatic changes
      </p>
      <ul className="space-y-1">
        {actions.slice(0, 5).map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {a.inventory_items?.title ?? "Item"}
            </span>
            <span className="shrink-0 tabular-nums">
              {a.old_price_cents != null && (
                <span className="text-muted-foreground line-through">
                  {money(a.old_price_cents)}
                </span>
              )}
              {a.new_price_cents != null && (
                <span className="ml-1 font-medium">{money(a.new_price_cents)}</span>
              )}
              <span className="ml-1 text-muted-foreground">
                {new Date(a.created_at).toLocaleDateString()}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RepriceRulesCard() {
  const { data: rules = [], isLoading } = useRepriceRules();
  const run = useRunRepriceRules();
  const update = useUpdateRepriceRule();
  const del = useDeleteRepriceRule();
  const confirm = useConfirm();

  async function onDelete(r: RepriceRule) {
    const ok = await confirm({
      title: "Delete this rule?",
      description: `"${r.name}" will stop running. This can't be undone.`,
      confirmLabel: "Delete rule",
    });
    if (ok) del.mutate(r.id);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Automation rules</CardTitle>
          <p className="text-xs text-muted-foreground">
            Scheduled markdowns behind these nudges. Run them now to apply any
            drops that are due.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CreateRuleDialog />
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: (res) =>
                  toast.success(
                    `Rules run — ${res.applied} price${res.applied === 1 ? "" : "s"} changed.`,
                  ),
              })
            }
          >
            {run.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            Run rules now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automation rules yet. Create one to age out slow inventory
            automatically.
          </p>
        ) : (
          <ul className="space-y-2">
            {rules.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="truncate font-medium">{r.name}</span>
                  <p className="text-xs text-muted-foreground">
                    {ruleSummary(r)}
                    {r.last_run_at &&
                      ` · ran ${new Date(r.last_run_at).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={r.enabled}
                    disabled={update.isPending}
                    aria-label={r.enabled ? "Pause rule" : "Enable rule"}
                    onCheckedChange={(v) =>
                      update.mutate({ id: r.id, input: { ...ruleToInput(r), enabled: v } })
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-muted-foreground"
                    aria-label={`Delete rule: ${r.name}`}
                    disabled={del.isPending}
                    onClick={() => void onDelete(r)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <RepriceActionsFeed />
      </CardContent>
    </Card>
  );
}

export function FlipdeskRepricingPage() {
  const {
    data: suggestions = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useRepricingSuggestions();
  const scan = useScanRepricing();
  const bulkApply = useBulkRepriceApply();
  const confirm = useConfirm();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ReasonFilter>("ALL");
  const [sort, setSort] = useState<SortKey>("delta_desc");
  const [page, setPage] = useState(0);

  // Filter by reason, then sort by the magnitude of the suggested change so the
  // biggest moves lead — sign is shown per row, so ranking by absolute delta
  // answers "where does acting change the most money".
  const filtered = useMemo(() => {
    const rows =
      reason === "ALL"
        ? suggestions
        : suggestions.filter((s) => s.reason_code === reason);
    return [...rows].sort((a, b) => {
      const diff = Math.abs(repriceDelta(b)) - Math.abs(repriceDelta(a));
      return sort === "delta_desc" ? diff : -diff;
    });
  }, [suggestions, reason, sort]);

  // A changed filter/sort can shrink the list below the current page — clamp.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [reason, sort]);

  const filteredIds = filtered.map((s) => s.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const selectedCount = filtered.filter((s) => selected.has(s.id)).length;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      if (filteredIds.every((id) => prev.has(id))) {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  }

  // Bulk apply, cents-safe: reuse useBulkRepriceApply (US-962), whose payload is
  // already {listing_id, price_cents} — no unit conversion, no per-row round trip.
  function revertRows(priors: Array<{ listing_id: string; price_cents: number }>) {
    if (priors.length === 0) return;
    bulkApply.mutate(priors, {
      onSuccess: (res) =>
        toast.success(`Reverted ${res.applied} price${res.applied === 1 ? "" : "s"}.`),
    });
  }

  async function applyRows(rows: RepriceSuggestion[]) {
    if (rows.length === 0) return;
    const ok = await confirm({
      title: `Apply ${rows.length} new price${rows.length === 1 ? "" : "s"}?`,
      description:
        `This updates ${rows.length} live eBay listing${rows.length === 1 ? "" : "s"} to their ` +
        `condition-matched suggested prices. Rows below the margin floor or with no ` +
        `comps are skipped server-side.`,
      confirmLabel: "Apply prices",
    });
    if (!ok) return;
    const items = rows.map((s) => ({
      listing_id: s.listing_id,
      price_cents: s.suggested_price_cents,
    }));
    // US-2171 AC5: capture each row's PRIOR price so the apply is reversible —
    // re-applying these restores exactly what changed, cents-for-cents.
    const priorByListing = new Map(
      rows.map((s) => [s.listing_id, s.current_price_cents]),
    );
    bulkApply.mutate(items, {
      onSuccess: (res) => {
        setSelected(new Set());
        const parts = [`${res.applied} applied`];
        if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
        if (res.errors.length) parts.push(`${res.errors.length} failed`);
        // Undo only the rows that actually changed (skips never moved).
        const skipped = new Set(res.skipped.map((x) => x.listing_id));
        const priors = [...priorByListing.entries()]
          .filter(([id]) => !skipped.has(id))
          .map(([listing_id, price_cents]) => ({ listing_id, price_cents }));
        toast.success(`Repricing: ${parts.join(" · ")}.`, {
          action:
            res.applied > 0
              ? { label: "Undo", onClick: () => revertRows(priors) }
              : undefined,
        });
      },
    });
  }

  const hasSuggestions = suggestions.length > 0;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Repricing"
        subtitle={
          <>
            Condition-aware price nudges. We compare each active listing against{" "}
            <Term name="Comp">comps</Term> matched to its grade, so a grade-9 is
            not priced like a grade-6.
          </>
        }
        actions={
          <Button onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
            {scan.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Scan now
          </Button>
        }
      />
      {/* US-460: comps are active asking prices, not sold prices. Kept out of
          the header subtitle so it survives when a tab host suppresses it. */}
      <p className="text-xs text-muted-foreground">
        Comps are <strong>active</strong> asking prices, not sold prices — real
        sale prices are usually lower, so nudges trend toward a ceiling.
      </p>

      <RepriceRulesCard />

      {/* US-2171: queue controls — filter, sort, bulk select + apply. */}
      {hasSuggestions && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
          <Checkbox
            checked={allFilteredSelected}
            onCheckedChange={toggleSelectAllFiltered}
            aria-label="Select all shown suggestions"
          />
          <span className="text-sm text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : `${filtered.length} nudges`}
          </span>
          <Select value={reason} onValueChange={(v) => setReason(v as ReasonFilter)}>
            <SelectTrigger aria-label="Filter suggestions by reason" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All reasons</SelectItem>
              {FILTERABLE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {REASON_META[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger aria-label="Sort suggestions by price change" className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="delta_desc">Biggest change first</SelectItem>
              <SelectItem value="delta_asc">Smallest change first</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedCount === 0 || bulkApply.isPending}
              onClick={() => applyRows(filtered.filter((s) => selected.has(s.id)))}
            >
              {bulkApply.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              Apply selected
            </Button>
            <Button
              size="sm"
              disabled={filtered.length === 0 || bulkApply.isPending}
              onClick={() => applyRows(filtered)}
            >
              Apply all ({filtered.length})
            </Button>
          </div>
        </div>
      )}

      {isError ? (
        <ErrorState
          title="Couldn't load repricing suggestions"
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : suggestions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No repricing nudges right now</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Run a scan to check your active eBay listings against condition-matched
            comps. We'll surface anything underpriced, overpriced, or stale here.
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No {reason === "ALL" ? "" : REASON_META[reason].label.toLowerCase() + " "}
            nudges match this filter.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            {pageRows.map((s) => (
              <SuggestionRow
                key={s.id}
                s={s}
                selected={selected.has(s.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
