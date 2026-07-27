import { useMemo, useState } from "react";
import {
  Activity,
  FlaskConical,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FilterBuilder } from "@/components/flipdesk/filter-builder";
import {
  describeRule,
  EMPTY_QUERY,
  type FilterQuery,
} from "@/lib/item-filter";
import {
  type AutomationAction,
  type AutomationDryRunMatch,
  type AutomationRule,
  type AutomationRuleInput,
  type AutomationScopeRule,
  type AutomationTrigger,
  useAutomationRuleActions,
  useAutomationRules,
  useCreateAutomationRule,
  useDeleteAutomationRule,
  useDryRunAutomationRule,
  useRunAutomations,
  useUpdateAutomationRule,
} from "@/hooks/use-automations";

// Price-drop and promo scheduler (US-150). Rules run hourly server-side;
// "Run now" applies them immediately, "Dry run" previews per rule without
// applying. Per-item opt-out lives on the item detail page.

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function describeTrigger(t: AutomationTrigger): string {
  switch (t.type) {
    case "days_listed_gt":
      return `listed more than ${t.days} days`;
    case "no_views_in_days":
      return `no views after ${t.days} days`;
    case "watchers_lt_after_days":
      return `fewer than ${t.watchers} watchers after ${t.days} days`;
  }
}

function describeAction(a: AutomationAction): string {
  switch (a.type) {
    case "price_drop_pct":
      return `drop price ${a.pct}% (floor: cost +${a.margin_floor_pct}%)`;
    case "set_promo_rate_pct":
      return `set promo rate to ${a.pct}%`;
    case "create_coded_coupon":
      return `create a ${a.discount_pct}% coded coupon`;
    case "end_listing":
      return "end the listing";
  }
}

function describeScope(rule: AutomationRule): string {
  const s = rule.scope_json;
  if (s.type === "all" || !s.rules?.length) return "all active listings";
  const parts = s.rules.map((r) => describeRule({ ...r, id: r.id ?? "" }));
  return `listings where ${parts.join(s.combinator === "and" ? " and " : " or ")}`;
}

const ACTION_LABELS: Record<AutomationAction["type"], string> = {
  price_drop_pct: "Price drop",
  set_promo_rate_pct: "Promo rate",
  create_coded_coupon: "Coded coupon",
  end_listing: "End listing",
};

// ── Create/edit dialog ──────────────────────────────────────────

// Server-stored scope rules have no `id`; the FilterBuilder needs one per row.
function withIds(q: {
  combinator: "and" | "or";
  rules: AutomationScopeRule[];
}): FilterQuery {
  return {
    combinator: q.combinator,
    rules: q.rules.map((r) => ({
      ...r,
      id: r.id ?? Math.random().toString(36).slice(2),
    })),
  };
}

function RuleDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: AutomationRule | null;
}) {
  const create = useCreateAutomationRule();
  const update = useUpdateAutomationRule();

  const [name, setName] = useState(initial?.name ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [triggerType, setTriggerType] = useState<AutomationTrigger["type"]>(
    initial?.trigger_json.type ?? "days_listed_gt",
  );
  const [triggerDays, setTriggerDays] = useState(
    String(initial?.trigger_json.days ?? 30),
  );
  const [triggerWatchers, setTriggerWatchers] = useState(
    String(
      initial?.trigger_json.type === "watchers_lt_after_days"
        ? initial.trigger_json.watchers
        : 2,
    ),
  );
  const [cooldownDays, setCooldownDays] = useState(
    String(initial?.trigger_json.cooldown_days ?? 7),
  );
  const [actionType, setActionType] = useState<AutomationAction["type"]>(
    initial?.action_json.type ?? "price_drop_pct",
  );
  const [actionPct, setActionPct] = useState(
    String(
      initial?.action_json.type === "price_drop_pct" ||
        initial?.action_json.type === "set_promo_rate_pct"
        ? initial.action_json.pct
        : initial?.action_json.type === "create_coded_coupon"
          ? initial.action_json.discount_pct
          : 10,
    ),
  );
  const [marginFloorPct, setMarginFloorPct] = useState(
    String(
      initial?.action_json.type === "price_drop_pct"
        ? initial.action_json.margin_floor_pct
        : 10,
    ),
  );
  const [scopeMode, setScopeMode] = useState<"all" | "filter">(
    initial?.scope_json.type === "filter" ? "filter" : "all",
  );
  const [scopeQuery, setScopeQuery] = useState<FilterQuery>(
    initial?.scope_json.type === "filter"
      ? withIds(initial.scope_json)
      : EMPTY_QUERY,
  );

  const saving = create.isPending || update.isPending;

  function buildInput(): AutomationRuleInput {
    const days = Math.max(1, Math.trunc(Number(triggerDays) || 1));
    const cooldown = Math.max(1, Math.trunc(Number(cooldownDays) || 7));
    const trigger: AutomationTrigger =
      triggerType === "watchers_lt_after_days"
        ? {
            type: triggerType,
            watchers: Math.max(1, Math.trunc(Number(triggerWatchers) || 1)),
            days,
            cooldown_days: cooldown,
          }
        : { type: triggerType, days, cooldown_days: cooldown };
    const pct = Number(actionPct) || 0;
    const action: AutomationAction =
      actionType === "price_drop_pct"
        ? {
            type: actionType,
            pct,
            margin_floor_pct: Math.max(0, Math.trunc(Number(marginFloorPct) || 0)),
          }
        : actionType === "set_promo_rate_pct"
          ? { type: actionType, pct }
          : actionType === "create_coded_coupon"
            ? { type: actionType, discount_pct: pct }
            : { type: actionType };
    return {
      name: name.trim(),
      is_active: isActive,
      trigger_json: trigger,
      action_json: action,
      scope_json:
        scopeMode === "filter" && scopeQuery.rules.length > 0
          ? {
              type: "filter",
              combinator: scopeQuery.combinator,
              rules: scopeQuery.rules,
            }
          : { type: "all" },
    };
  }

  function submit() {
    const input = buildInput();
    const onSuccess = () => onOpenChange(false);
    if (initial) update.mutate({ id: initial.id, input }, { onSuccess });
    else create.mutate(input, { onSuccess });
  }

  const needsPct = actionType !== "end_listing";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit rule" : "New automation rule"}</DialogTitle>
          <DialogDescription>
            e.g. “drop 10% after 30 days listed.” Rules run hourly against your
            active eBay listings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Stale inventory markdown"
              maxLength={80}
            />
          </div>

          <div className="space-y-1.5">
            <Label>When</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as AutomationTrigger["type"])}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days_listed_gt">Listed more than…</SelectItem>
                  <SelectItem value="no_views_in_days">No views after…</SelectItem>
                  <SelectItem value="watchers_lt_after_days">
                    Few watchers after…
                  </SelectItem>
                </SelectContent>
              </Select>
              {triggerType === "watchers_lt_after_days" && (
                <span className="flex items-center gap-1.5 text-sm">
                  <Input
                    type="number"
                    min={1}
                    value={triggerWatchers}
                    onChange={(e) => setTriggerWatchers(e.target.value)}
                    className="w-20"
                    aria-label="Watcher threshold"
                  />
                  watchers,
                </span>
              )}
              <span className="flex items-center gap-1.5 text-sm">
                <Input
                  type="number"
                  min={1}
                  value={triggerDays}
                  onChange={(e) => setTriggerDays(e.target.value)}
                  className="w-20"
                  aria-label="Day threshold"
                />
                days
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Re-apply at most every
              <Input
                type="number"
                min={1}
                value={cooldownDays}
                onChange={(e) => setCooldownDays(e.target.value)}
                className="w-20"
                aria-label="Cooldown days"
              />
              days per listing
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Then</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={actionType}
                onValueChange={(v) => setActionType(v as AutomationAction["type"])}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="price_drop_pct">Drop price by %</SelectItem>
                  <SelectItem value="set_promo_rate_pct">Set promo rate %</SelectItem>
                  <SelectItem value="create_coded_coupon">Create coded coupon %</SelectItem>
                  <SelectItem value="end_listing">End the listing</SelectItem>
                </SelectContent>
              </Select>
              {needsPct && (
                <span className="flex items-center gap-1.5 text-sm">
                  <Input
                    type="number"
                    min={1}
                    max={
                      actionType === "price_drop_pct"
                        ? 90
                        : actionType === "create_coded_coupon"
                          ? 70
                          : 100
                    }
                    value={actionPct}
                    onChange={(e) => setActionPct(e.target.value)}
                    className="w-20"
                    aria-label="Percent"
                  />
                  %
                </span>
              )}
            </div>
            {actionType === "price_drop_pct" && (
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                Never below cost +
                <Input
                  type="number"
                  min={0}
                  value={marginFloorPct}
                  onChange={(e) => setMarginFloorPct(e.target.value)}
                  className="w-20"
                  aria-label="Margin floor percent"
                />
                % margin
              </div>
            )}
            {actionType === "set_promo_rate_pct" && (
              <p className="text-xs text-muted-foreground">
                Tracked in FlipDesk for now — the rate isn't pushed to eBay
                Promoted Listings yet.
              </p>
            )}
            {actionType === "create_coded_coupon" && (
              <p className="text-xs text-muted-foreground">
                Creates an eBay coded coupon (5–70%) for the aged listing — the
                code is generated automatically and the listing's cover photo is
                used as the promotion image eBay requires. Share the code from
                eBay Seller Hub → Marketing.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <div className="flex items-center gap-2">
              <Select
                value={scopeMode}
                onValueChange={(v) => setScopeMode(v as "all" | "filter")}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All active listings</SelectItem>
                  <SelectItem value="filter">Filtered listings…</SelectItem>
                </SelectContent>
              </Select>
              {scopeMode === "filter" && (
                <FilterBuilder query={scopeQuery} onChange={setScopeQuery} />
              )}
            </div>
            {scopeMode === "filter" && scopeQuery.rules.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {scopeQuery.rules.map((r) => describeRule(r)).join(
                  scopeQuery.combinator === "and" ? " and " : " or ",
                )}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="rule-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
            <Label htmlFor="rule-active">Active</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {initial ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Dry-run results ─────────────────────────────────────────────

function DryRunResults({
  scanned,
  affected,
}: {
  scanned: number;
  affected: AutomationDryRunMatch[];
}) {
  if (affected.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Dry run: no listings would be affected right now ({scanned} scanned).
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-2">
      <p className="px-1 text-xs font-medium">
        Dry run: {affected.length} listing{affected.length === 1 ? "" : "s"} would
        be affected ({scanned} scanned) — nothing was applied.
      </p>
      <ul className="space-y-1">
        {affected.map((m) => (
          <li
            key={m.listing_id}
            className="flex flex-wrap items-center gap-2 px-1 text-xs"
          >
            <span className="truncate font-medium">
              {m.title ?? "Untitled item"}
            </span>
            {m.action_type === "price_drop_pct" && m.new_price_cents != null && (
              <span className="text-muted-foreground">
                {money(m.current_price_cents)} →{" "}
                <span className="font-medium text-foreground">
                  {money(m.new_price_cents)}
                </span>
                {m.floored && " (clamped to margin floor)"}
              </span>
            )}
            {m.action_type === "set_promo_rate_pct" && (
              <span className="text-muted-foreground">
                promo {m.current_promo_rate_pct ?? 0}% →{" "}
                <span className="font-medium text-foreground">
                  {m.new_promo_rate_pct}%
                </span>
              </span>
            )}
            {m.action_type === "end_listing" && (
              <span className="text-muted-foreground">would be ended</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Activity log ────────────────────────────────────────────────

function RuleActivity({ ruleId }: { ruleId: string }) {
  const { data: actions = [], isLoading } = useAutomationRuleActions(ruleId, true);
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (actions.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        No actions taken by this rule yet.
      </p>
    );
  }
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-2">
      {actions.map((a) => {
        const beforeCents = a.before_json?.price_cents as number | undefined;
        const afterCents = a.after_json?.price_cents as number | undefined;
        const beforeRate = a.before_json?.promo_rate_pct as number | null | undefined;
        const afterRate = a.after_json?.promo_rate_pct as number | undefined;
        return (
          <li
            key={a.id}
            className="flex flex-wrap items-center gap-2 px-1 text-xs"
          >
            <span className="whitespace-nowrap text-muted-foreground">
              {new Date(a.created_at).toLocaleString()}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {ACTION_LABELS[a.action_type]}
            </Badge>
            <span className="truncate font-medium">
              {a.inventory_items?.title ?? "Untitled item"}
            </span>
            {a.action_type === "price_drop_pct" &&
              beforeCents != null &&
              afterCents != null && (
                <span className="text-muted-foreground">
                  {money(beforeCents)} → {money(afterCents)}
                </span>
              )}
            {a.action_type === "set_promo_rate_pct" && afterRate != null && (
              <span className="text-muted-foreground">
                promo {beforeRate ?? 0}% → {afterRate}%
              </span>
            )}
            {a.action_type === "end_listing" && (
              <span className="text-muted-foreground">ended</span>
            )}
            {!a.ebay_synced && a.action_type !== "set_promo_rate_pct" && (
              <span className="text-amber-600 dark:text-amber-400">local only</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Rule card ───────────────────────────────────────────────────

function RuleCard({
  rule,
  onEdit,
}: {
  rule: AutomationRule;
  onEdit: (rule: AutomationRule) => void;
}) {
  const confirm = useConfirm();
  const update = useUpdateAutomationRule();
  const del = useDeleteAutomationRule();
  const dryRun = useDryRunAutomationRule();
  const [showActivity, setShowActivity] = useState(false);

  function toggleActive(next: boolean) {
    update.mutate({
      id: rule.id,
      input: {
        name: rule.name,
        is_active: next,
        trigger_json: rule.trigger_json,
        action_json: rule.action_json,
        scope_json: rule.scope_json,
      },
    });
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete “${rule.name}”?`,
      description:
        "The rule and its activity log are removed. Listings it already changed keep their current price.",
      confirmLabel: "Delete rule",
      destructive: true,
    });
    if (ok) del.mutate(rule.id);
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
      <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={rule.is_active}
            onCheckedChange={toggleActive}
            disabled={update.isPending}
            aria-label={`Toggle ${rule.name}`}
          />
          <span className="font-medium">{rule.name}</span>
          <Badge variant="outline" className="text-xs">
            {ACTION_LABELS[rule.action_json.type]}
          </Badge>
          {!rule.is_active && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Paused
            </Badge>
          )}
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                dryRun.mutate(rule.id, { onSuccess: () => setShowActivity(false) })
              }
              disabled={dryRun.isPending}
            >
              {dryRun.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
              )}
              Dry run
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowActivity((v) => !v)}
            >
              <Activity className="mr-1.5 h-3.5 w-3.5" />
              Activity
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEdit(rule)}
              aria-label="Edit rule"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={remove}
              disabled={del.isPending}
              aria-label="Delete rule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          When {describeTrigger(rule.trigger_json)}, {describeAction(rule.action_json)}{" "}
          — {describeScope(rule)}. Re-checks at most every{" "}
          {rule.trigger_json.cooldown_days} day
          {rule.trigger_json.cooldown_days === 1 ? "" : "s"} per listing.
          {rule.last_run_at &&
            ` Last run ${new Date(rule.last_run_at).toLocaleString()}.`}
        </p>
        {dryRun.data && !showActivity && (
          <DryRunResults
            scanned={dryRun.data.listings_scanned}
            affected={dryRun.data.affected}
          />
        )}
        {showActivity && <RuleActivity ruleId={rule.id} />}
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────

export function FlipdeskAutomationsPage() {
  const { data: rules = [], isLoading } = useAutomationRules();
  const run = useRunAutomations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationRule | null>(null);

  // Remount the dialog per open/target so field state re-initializes.
  const dialogKey = useMemo(
    () => (editing ? `edit-${editing.id}-${editing.updated_at}` : "create"),
    [editing],
  );

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(rule: AutomationRule) {
    setEditing(rule);
    setDialogOpen(true);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Automations"
        subtitle="Schedule price drops, promo rates, or end-listings for stale inventory — rules run hourly. Prices never drop below cost plus your margin floor."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => run.mutate()}
              disabled={run.isPending || rules.every((r) => !r.is_active)}
            >
              {run.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run now
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              New rule
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : rules.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-brand-red-text" />
              No automation rules yet
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Create a rule like “drop 10% after 30 days listed” and FlipDesk
            applies it for you every hour. Use Dry run to preview which
            listings a rule would touch, and exclude individual items from the
            item detail page.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} onEdit={openEdit} />
          ))}
        </div>
      )}

      {dialogOpen && (
        <RuleDialog
          key={dialogKey}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          initial={editing}
        />
      )}
    </div>
  );
}
