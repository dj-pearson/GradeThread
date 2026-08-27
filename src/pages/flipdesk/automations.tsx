import { useId, useMemo, useState } from "react";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
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
  AUTOMATION_CROSSLIST_PLATFORMS,
  AUTOMATION_MESSAGE_MAX,
  AUTOMATION_SETTABLE_STATUSES,
  type AutomationDryRunMatch,
  type AutomationRule,
  type AutomationRuleInput,
  type AutomationScopeRule,
  type AutomationTrigger,
  MAX_WATCHER_OFFER_PCT,
  MIN_WATCHER_OFFER_PCT,
  useAutomationRuleActions,
  useAutomationRules,
  useCreateAutomationRule,
  useDeleteAutomationRule,
  useDryRunAutomationRule,
  useRunAutomations,
  useUpdateAutomationRule,
} from "@/hooks/use-automations";
import { useEbayNegotiationCapability } from "@/hooks/use-ebay";
import {
  ITEM_STATUS_LABELS,
  ITEM_STATUSES,
  MARKETPLACE_LABELS,
} from "@/lib/constants";

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
    case "offer_received":
      return `an offer came in within ${t.days} days`;
    case "return_opened":
      return `a return was opened within ${t.days} days`;
    case "compliance_violation":
      return t.min_violations > 1
        ? `${t.min_violations} or more policy violations`
        : "a policy violation is open";
    case "grade_completed":
      return t.max_grade == null
        ? `graded within ${t.days} days`
        : `graded ${t.max_grade} or lower within ${t.days} days`;
    case "item_status_changed":
      return `moved to ${t.status} within ${t.days} days`;
    case "comp_price_moved":
      return t.direction === "above"
        ? `priced more than ${t.pct}% above comps`
        : `priced more than ${t.pct}% below comps`;
    case "offer_threshold": {
      const parts: string[] = [];
      if (t.accept_at_pct != null) parts.push(`accept at ${t.accept_at_pct}%+`);
      if (t.counter_at_pct != null) parts.push(`counter at ${t.counter_at_pct}%`);
      if (t.decline_below_pct != null) parts.push(`decline under ${t.decline_below_pct}%`);
      return `an offer arrives — ${parts.join(", ") || "no thresholds set"}`;
    }
    case "return_threshold": {
      const parts: string[] = [];
      if (t.approve_at_or_below_cents != null) {
        parts.push(`approve at or under $${(t.approve_at_or_below_cents / 100).toFixed(0)}`);
      }
      if (t.refund_without_return_at_or_below_cents != null) {
        parts.push(
          `refund and let them keep it at or under $${
            (t.refund_without_return_at_or_below_cents / 100).toFixed(0)
          }`,
        );
      }
      return `a return arrives — ${parts.join(", ") || "no limits set"}`;
    }
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
    case "relist":
      return "end it and send the item back to Drafts to relist";
    case "crosslist_to":
      return `cross-list it to ${a.platform}`;
    case "send_offer_to_watchers":
      return `offer watchers ${a.discount_pct}% off`;
    case "advance_status":
      return `move the item to ${a.status}`;
    case "notify":
      return `notify me: “${a.message}”`;
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
  relist: "Relist",
  crosslist_to: "Cross-list",
  send_offer_to_watchers: "Offer to watchers",
  advance_status: "Move status",
  notify: "Notify",
};

/**
 * Actions that reach eBay when they succeed. US-2156: the "local only" marker
 * means "we changed our copy but the marketplace doesn't know" — which is a
 * warning for a price drop and nonsense for a notify or a status move, neither
 * of which has anything to push.
 */
const EBAY_BACKED_ACTIONS = new Set<AutomationAction["type"]>([
  "price_drop_pct",
  "set_promo_rate_pct",
  "create_coded_coupon",
  "end_listing",
  "relist",
  "send_offer_to_watchers",
]);

// US-2156. Split so the "When" picker groups the calendar triggers apart from
// the pipeline ones, and so each row can say which extra inputs it needs.
const TRIGGER_OPTIONS: Array<{
  value: AutomationTrigger["type"];
  label: string;
  group: "Aging" | "Pipeline" | "Offers" | "Returns";
  /** Shows the trailing "…days" input. */
  days: boolean;
}> = [
  { value: "days_listed_gt", label: "Listed more than…", group: "Aging", days: true },
  { value: "no_views_in_days", label: "No views after…", group: "Aging", days: true },
  { value: "watchers_lt_after_days", label: "Few watchers after…", group: "Aging", days: true },
  { value: "offer_received", label: "An offer came in…", group: "Pipeline", days: true },
  { value: "return_opened", label: "A return was opened…", group: "Pipeline", days: true },
  { value: "grade_completed", label: "A grade came back…", group: "Pipeline", days: true },
  { value: "item_status_changed", label: "The item moved to…", group: "Pipeline", days: true },
  { value: "compliance_violation", label: "A policy violation is open", group: "Pipeline", days: false },
  { value: "comp_price_moved", label: "Price drifted from comps…", group: "Pipeline", days: false },
  { value: "offer_threshold", label: "An offer arrives (auto answer)…", group: "Offers", days: false },
  { value: "return_threshold", label: "A return arrives (auto answer)…", group: "Returns", days: false },
];

const ACTION_OPTIONS: Array<{
  value: AutomationAction["type"];
  label: string;
  /** Shows the trailing "…%" input, and its cap. */
  pctMax: number | null;
}> = [
  { value: "price_drop_pct", label: "Drop price by %", pctMax: 90 },
  { value: "set_promo_rate_pct", label: "Set promo rate %", pctMax: 100 },
  { value: "create_coded_coupon", label: "Create coded coupon %", pctMax: 70 },
  { value: "send_offer_to_watchers", label: "Offer watchers % off", pctMax: MAX_WATCHER_OFFER_PCT },
  { value: "crosslist_to", label: "Cross-list to…", pctMax: null },
  { value: "advance_status", label: "Move the item to…", pctMax: null },
  { value: "notify", label: "Notify me", pctMax: null },
  { value: "relist", label: "End it and relist", pctMax: null },
  { value: "end_listing", label: "End the listing", pctMax: null },
];

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
  // US-1967 + US-2156: don't offer an action the deployment can't perform. Only
  // probed while the dialog is open — the answer changes on a licensing change,
  // not minute to minute.
  const negotiation = useEbayNegotiationCapability(open);
  const watcherOffersAvailable = negotiation.data?.sendOfferAvailable ?? false;

  const [name, setName] = useState(initial?.name ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [triggerType, setTriggerType] = useState<AutomationTrigger["type"]>(
    initial?.trigger_json.type ?? "days_listed_gt",
  );
  const [triggerDays, setTriggerDays] = useState(
    // US-2156: two triggers (compliance_violation, comp_price_moved) carry no
    // day count at all, so this reads it only when the shape has one.
    String(
      initial && "days" in initial.trigger_json ? initial.trigger_json.days : 30,
    ),
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
  // US-2236. Empty string means "no threshold", NOT zero — a 0 would clamp to
  // 1% and auto-decline nearly every offer the seller receives.
  const [acceptAtPct, setAcceptAtPct] = useState(
    initial?.trigger_json.type === "offer_threshold" &&
      initial.trigger_json.accept_at_pct != null
      ? String(initial.trigger_json.accept_at_pct)
      : "",
  );
  const [declineBelowPct, setDeclineBelowPct] = useState(
    initial?.trigger_json.type === "offer_threshold" &&
      initial.trigger_json.decline_below_pct != null
      ? String(initial.trigger_json.decline_below_pct)
      : "",
  );
  const [counterAtPct, setCounterAtPct] = useState(
    initial?.trigger_json.type === "offer_threshold" &&
      initial.trigger_json.counter_at_pct != null
      ? String(initial.trigger_json.counter_at_pct)
      : "",
  );
  const [offerMarginFloorPct, setOfferMarginFloorPct] = useState(
    String(
      initial?.trigger_json.type === "offer_threshold"
        ? initial.trigger_json.margin_floor_pct
        : 10,
    ),
  );
  // US-2938. Whole dollars in the box, cents on the wire. Empty means "off",
  // never zero — the same blank-means-blank discipline the offer thresholds use.
  const [approveAtDollars, setApproveAtDollars] = useState(
    initial?.trigger_json.type === "return_threshold" &&
      initial.trigger_json.approve_at_or_below_cents != null
      ? String(initial.trigger_json.approve_at_or_below_cents / 100)
      : "",
  );
  const [keepItAtDollars, setKeepItAtDollars] = useState(
    initial?.trigger_json.type === "return_threshold" &&
      initial.trigger_json.refund_without_return_at_or_below_cents != null
      ? String(initial.trigger_json.refund_without_return_at_or_below_cents / 100)
      : "",
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
  // ── US-2156 per-shape inputs ──────────────────────────────────
  const [minViolations, setMinViolations] = useState(
    String(
      initial?.trigger_json.type === "compliance_violation"
        ? initial.trigger_json.min_violations
        : 1,
    ),
  );
  const [maxGrade, setMaxGrade] = useState(
    initial?.trigger_json.type === "grade_completed" &&
      initial.trigger_json.max_grade != null
      ? String(initial.trigger_json.max_grade)
      : "",
  );
  const [triggerStatus, setTriggerStatus] = useState(
    initial?.trigger_json.type === "item_status_changed"
      ? initial.trigger_json.status
      : "returned",
  );
  const [compDirection, setCompDirection] = useState<"above" | "below">(
    initial?.trigger_json.type === "comp_price_moved"
      ? initial.trigger_json.direction
      : "above",
  );
  const [compPct, setCompPct] = useState(
    String(
      initial?.trigger_json.type === "comp_price_moved"
        ? initial.trigger_json.pct
        : 20,
    ),
  );
  const [actionPlatform, setActionPlatform] = useState(
    initial?.action_json.type === "crosslist_to"
      ? initial.action_json.platform
      : AUTOMATION_CROSSLIST_PLATFORMS[0],
  );
  const [actionStatus, setActionStatus] = useState(
    initial?.action_json.type === "advance_status"
      ? initial.action_json.status
      : "archived",
  );
  const [actionMessage, setActionMessage] = useState(
    initial?.action_json.type === "notify" ? initial.action_json.message : "",
  );
  // US-2335: ids for the When / Then / Applies-to trio.
  const triggerTypeId = useId();
  const actionTypeId = useId();
  const scopeModeId = useId();
  const [scopeMode, setScopeMode] = useState<"all" | "filter">(
    initial?.scope_json.type === "filter" ? "filter" : "all",
  );
  const [scopeQuery, setScopeQuery] = useState<FilterQuery>(
    initial?.scope_json.type === "filter"
      ? withIds(initial.scope_json)
      : EMPTY_QUERY,
  );

  const saving = create.isPending || update.isPending;

  // US-2156: one arm per trigger/action shape. The server re-validates all of
  // it (normalizeAutomationInput) — this only has to produce the right shape.
  function buildTrigger(days: number, cooldown: number): AutomationTrigger {
    switch (triggerType) {
      case "watchers_lt_after_days":
        return {
          type: triggerType,
          watchers: Math.max(1, Math.trunc(Number(triggerWatchers) || 1)),
          days,
          cooldown_days: cooldown,
        };
      case "compliance_violation":
        return {
          type: triggerType,
          min_violations: Math.max(1, Math.trunc(Number(minViolations) || 1)),
          cooldown_days: cooldown,
        };
      case "grade_completed": {
        const g = Number(maxGrade);
        return {
          type: triggerType,
          days,
          max_grade: maxGrade.trim() && Number.isFinite(g) ? g : null,
          cooldown_days: cooldown,
        };
      }
      case "item_status_changed":
        return { type: triggerType, status: triggerStatus, days, cooldown_days: cooldown };
      case "comp_price_moved":
        return {
          type: triggerType,
          direction: compDirection,
          pct: Math.max(1, Math.trunc(Number(compPct) || 1)),
          cooldown_days: cooldown,
        };
      case "offer_threshold": {
        // A BLANK field is null, not 0. `Number("")` is 0 and would clamp to
        // 1%, which on the decline side means auto-declining almost every offer
        // — the worst possible reading of "I left that box empty".
        const pct = (v: string) => {
          const t = v.trim();
          if (!t) return null;
          const n = Number(t);
          return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.trunc(n))) : null;
        };
        return {
          type: triggerType,
          accept_at_pct: pct(acceptAtPct),
          counter_at_pct: pct(counterAtPct),
          decline_below_pct: pct(declineBelowPct),
          margin_floor_pct: Math.max(0, Math.trunc(Number(offerMarginFloorPct) || 0)),
          cooldown_days: cooldown,
        };
      }
      case "return_threshold": {
        // A BLANK field is null, not 0 — `Number("")` is 0, and a zero limit
        // would read as "auto-approve nothing" when the seller meant "off",
        // which is the harmless direction here but the wrong one everywhere
        // else. One rule, spelled the same way in both places.
        const cents = (v: string) => {
          const t = v.trim();
          if (!t) return null;
          const n = Number(t);
          return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
        };
        return {
          type: triggerType,
          approve_at_or_below_cents: cents(approveAtDollars),
          refund_without_return_at_or_below_cents: cents(keepItAtDollars),
          cooldown_days: cooldown,
        };
      }
      default:
        return { type: triggerType, days, cooldown_days: cooldown };
    }
  }

  function buildAction(pct: number): AutomationAction {
    switch (actionType) {
      case "price_drop_pct":
        return {
          type: actionType,
          pct,
          margin_floor_pct: Math.max(0, Math.trunc(Number(marginFloorPct) || 0)),
        };
      case "set_promo_rate_pct":
        return { type: actionType, pct };
      case "create_coded_coupon":
        return { type: actionType, discount_pct: pct };
      case "send_offer_to_watchers":
        return { type: actionType, discount_pct: pct };
      case "crosslist_to":
        return { type: actionType, platform: actionPlatform };
      case "advance_status":
        return { type: actionType, status: actionStatus };
      case "notify":
        return { type: actionType, message: actionMessage.trim() };
      default:
        return { type: actionType };
    }
  }

  function buildInput(): AutomationRuleInput {
    const days = Math.max(1, Math.trunc(Number(triggerDays) || 1));
    const cooldown = Math.max(1, Math.trunc(Number(cooldownDays) || 7));
    const trigger = buildTrigger(days, cooldown);
    const pct = Number(actionPct) || 0;
    const action = buildAction(pct);
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

  const triggerNeedsDays =
    TRIGGER_OPTIONS.find((o) => o.value === triggerType)?.days ?? true;
  const actionPctMax =
    ACTION_OPTIONS.find((o) => o.value === actionType)?.pctMax ?? null;

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
            <Label htmlFor={triggerTypeId}>When</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as AutomationTrigger["type"])}
              >
                <SelectTrigger className="w-56" id={triggerTypeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
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
              {triggerType === "item_status_changed" && (
                <Select value={triggerStatus} onValueChange={setTriggerStatus}>
                  <SelectTrigger className="w-40" aria-label="Item status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEM_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ITEM_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {triggerType === "grade_completed" && (
                <span className="flex items-center gap-1.5 text-sm">
                  grade at most
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    value={maxGrade}
                    onChange={(e) => setMaxGrade(e.target.value)}
                    className="w-20"
                    placeholder="any"
                    aria-label="Maximum grade"
                  />
                </span>
              )}
              {triggerType === "compliance_violation" && (
                <span className="flex items-center gap-1.5 text-sm">
                  at least
                  <Input
                    type="number"
                    min={1}
                    value={minViolations}
                    onChange={(e) => setMinViolations(e.target.value)}
                    className="w-20"
                    aria-label="Minimum violations"
                  />
                  open
                </span>
              )}
              {triggerType === "comp_price_moved" && (
                <span className="flex items-center gap-1.5 text-sm">
                  <Select
                    value={compDirection}
                    onValueChange={(v) => setCompDirection(v as "above" | "below")}
                  >
                    <SelectTrigger className="w-28" aria-label="Drift direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="above">above</SelectItem>
                      <SelectItem value="below">below</SelectItem>
                    </SelectContent>
                  </Select>
                  comps by
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={compPct}
                    onChange={(e) => setCompPct(e.target.value)}
                    className="w-20"
                    aria-label="Comp drift percent"
                  />
                  %
                </span>
              )}
              {triggerNeedsDays && (
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
              )}
            </div>
            {triggerType === "offer_threshold" && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  Accept at or above
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={acceptAtPct}
                    onChange={(e) => setAcceptAtPct(e.target.value)}
                    className="w-20"
                    aria-label="Auto-accept at percent of asking price"
                  />
                  % of asking
                </div>
                {/* US-2940. Between accept and decline in the form because it
                    is between them in the decision: accept beats counter, and
                    counter beats decline. */}
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  Counter at
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={counterAtPct}
                    onChange={(e) => setCounterAtPct(e.target.value)}
                    className="w-20"
                    aria-label="Auto-counter at percent of asking price"
                  />
                  % of asking
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  Decline under
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="off"
                    value={declineBelowPct}
                    onChange={(e) => setDeclineBelowPct(e.target.value)}
                    className="w-20"
                    aria-label="Auto-decline below percent of asking price"
                  />
                  % of asking
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  Never accept below cost +
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={offerMarginFloorPct}
                    onChange={(e) => setOfferMarginFloorPct(e.target.value)}
                    className="w-20"
                    aria-label="Minimum margin over cost for an auto-accept"
                  />
                  %
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave a box empty to turn that part off. Countering beats
                  declining, so with a counter set, an offer that would have been
                  declined becomes a counter instead. The cost floor blocks an
                  accept or a counter and never causes a decline, so a missing or
                  wrong purchase price can't lose you a sale.
                </p>
                <OfferRulePreview
                  acceptAtPct={acceptAtPct}
                  counterAtPct={counterAtPct}
                  declineBelowPct={declineBelowPct}
                  marginFloorPct={offerMarginFloorPct}
                />
              </div>
            )}
            {triggerType === "return_threshold" && (
              <ReturnRuleFields
                approveAtDollars={approveAtDollars}
                setApproveAtDollars={setApproveAtDollars}
                keepItAtDollars={keepItAtDollars}
                setKeepItAtDollars={setKeepItAtDollars}
              />
            )}
            {triggerType === "offer_received" && (
              <p className="text-xs text-muted-foreground">
                Reads the offers eBay has already told us about. Offers that
                landed before this feature shipped aren't on record, so a brand
                new rule starts matching from today.
              </p>
            )}
            {triggerType === "comp_price_moved" && (
              <p className="text-xs text-muted-foreground">
                Compares your asking price to the comp range stored on the
                listing. A listing with no comps yet never matches.
              </p>
            )}
            {triggerType === "offer_threshold" && (
              <p className="text-xs text-muted-foreground">
                Answers eBay Best Offers hourly. This rule's action below is
                ignored — accepting or declining IS the action. You are told
                every time it answers one.
              </p>
            )}
            {triggerType === "return_threshold" && (
              <p className="text-xs text-muted-foreground">
                Answers eBay returns hourly. This rule's action below is ignored
                — approving or refunding IS the action. A return filed as "not
                as described" is never answered automatically, whatever you set
                here.
              </p>
            )}
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
            <Label htmlFor={actionTypeId}>Then</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={actionType}
                onValueChange={(v) => setActionType(v as AutomationAction["type"])}
              >
                <SelectTrigger className="w-56" id={actionTypeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_OPTIONS.map((o) => (
                    <SelectItem
                      key={o.value}
                      value={o.value}
                      // US-1967: the negotiation scope is unlicensed on the
                      // production keyset, so the option is disabled rather
                      // than offered and then silently skipped at run time.
                      disabled={
                        o.value === "send_offer_to_watchers" &&
                        !watcherOffersAvailable
                      }
                    >
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {actionPctMax != null && (
                <span className="flex items-center gap-1.5 text-sm">
                  <Input
                    type="number"
                    min={
                      actionType === "send_offer_to_watchers"
                        ? MIN_WATCHER_OFFER_PCT
                        : 1
                    }
                    max={actionPctMax}
                    value={actionPct}
                    onChange={(e) => setActionPct(e.target.value)}
                    className="w-20"
                    aria-label="Percent"
                  />
                  %
                </span>
              )}
              {actionType === "crosslist_to" && (
                <Select value={actionPlatform} onValueChange={setActionPlatform}>
                  <SelectTrigger className="w-40" aria-label="Marketplace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_CROSSLIST_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {MARKETPLACE_LABELS[p] ?? p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {actionType === "advance_status" && (
                <Select value={actionStatus} onValueChange={setActionStatus}>
                  <SelectTrigger className="w-40" aria-label="New item status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_SETTABLE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ITEM_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {actionType === "notify" && (
              <Input
                value={actionMessage}
                onChange={(e) => setActionMessage(e.target.value)}
                placeholder="Check this one — it may need a new photo"
                maxLength={AUTOMATION_MESSAGE_MAX}
                aria-label="Notification message"
              />
            )}
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
                Sets the listing's eBay Promoted Listings ad rate. A listing that
                isn't live on eBay is skipped until it is.
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
            <Label htmlFor={scopeModeId}>Applies to</Label>
            <div className="flex items-center gap-2">
              <Select
                value={scopeMode}
                onValueChange={(v) => setScopeMode(v as "all" | "filter")}
              >
                <SelectTrigger className="w-56" id={scopeModeId}>
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
            {/* US-2156: the price/promo columns say nothing about a crosslist,
                a notify or a status move — without this the row reads as a
                match with no effect. */}
            {m.effect && <span className="text-muted-foreground">{m.effect}</span>}
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
            {/* US-2156: one line per new action, read off what was recorded. */}
            {a.action_type === "relist" && (
              <span className="text-muted-foreground">ended, back in Drafts</span>
            )}
            {a.action_type === "crosslist_to" && (
              <span className="text-muted-foreground">
                cross-listed to {String(a.after_json?.platform ?? "another marketplace")}
              </span>
            )}
            {a.action_type === "send_offer_to_watchers" && (
              <span className="text-muted-foreground">
                offered watchers {String(a.after_json?.discount_pct ?? "")}% off
              </span>
            )}
            {a.action_type === "advance_status" && (
              <span className="text-muted-foreground">
                {String(a.before_json?.status ?? "?")} →{" "}
                {String(a.after_json?.status ?? "?")}
              </span>
            )}
            {a.action_type === "notify" && (
              <span className="truncate text-muted-foreground">
                {String(a.after_json?.message ?? "notified")}
              </span>
            )}
            {/* A local-only marker is meaningless for actions that never touch
                eBay — it would read as a failure on a notify that worked. */}
            {!a.ebay_synced && EBAY_BACKED_ACTIONS.has(a.action_type) && (
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


// ── US-2938: the return-rule fields, with the dry run built in ──────
//
// The preview is not a nicety. This rule refunds buyers, and a seller who
// cannot see the item list before switching it on is being asked to trust a
// number they typed against data they have not looked at. So the preview sits
// in the form rather than behind a link, and it reports the SKIPS with their
// reasons too — "nothing would have fired" is the most useful answer this can
// give, and it is invisible if only the hits are listed.

interface DryRunLine {
  externalId: string;
  decision: "approve" | "refund_keep" | "skip";
  reason: string;
}

interface DryRunResult {
  days: number;
  considered: number;
  wouldApprove: number;
  wouldRefundKeep: number;
  skipped: number;
  lines: DryRunLine[];
}

function ReturnRuleFields({
  approveAtDollars,
  setApproveAtDollars,
  keepItAtDollars,
  setKeepItAtDollars,
}: {
  approveAtDollars: string;
  setApproveAtDollars: (v: string) => void;
  keepItAtDollars: string;
  setKeepItAtDollars: (v: string) => void;
}) {
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const dollarsToCents = (v: string) => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  };
  const canPreview =
    dollarsToCents(approveAtDollars) != null || dollarsToCents(keepItAtDollars) != null;

  async function runPreview() {
    setRunning(true);
    setPreview(null);
    try {
      const res = await edgeFetch("/api/flipdesk/ebay/returns/rule-dry-run", {
        method: "POST",
        body: JSON.stringify({
          approve_at_or_below_cents: dollarsToCents(approveAtDollars),
          refund_without_return_at_or_below_cents: dollarsToCents(keepItAtDollars),
          days: 30,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "The preview failed.");
      setPreview(json as DryRunResult);
    } catch (err) {
      toastError(err, "Couldn't run the preview.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        Approve returns at or under $
        <Input
          type="number"
          min={1}
          placeholder="off"
          value={approveAtDollars}
          onChange={(e) => setApproveAtDollars(e.target.value)}
          className="w-24"
          aria-label="Auto-approve returns at or below this order total, in dollars"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        Refund and let them keep it at or under $
        <Input
          type="number"
          min={1}
          placeholder="off"
          value={keepItAtDollars}
          onChange={(e) => setKeepItAtDollars(e.target.value)}
          className="w-24"
          aria-label="Refund without asking for the item back, at or below this order total, in dollars"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Leave a box empty to turn that half off. There is no auto-decline:
        declining puts you on record refusing, and a return declined by mistake
        becomes an eBay case, which counts against your account. A "not as
        described" return is always left for you.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!canPreview || running}
        onClick={runPreview}
      >
        {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Show me what this would have done
      </Button>
      {preview && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <p className="text-sm">
            Over the last {preview.days} days: {preview.considered} return
            {preview.considered === 1 ? "" : "s"}, {preview.wouldApprove} approved,{" "}
            {preview.wouldRefundKeep} refunded outright, {preview.skipped} left for you.
          </p>
          {preview.lines.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {preview.lines.map((l) => (
                <li key={l.externalId}>
                  <span className="font-medium">{l.externalId}</span> — {l.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}


// ── US-2940: the offer-rule preview ─────────────────────────────────
//
// Countering answers a buyer with a price, automatically, with nobody watching.
// A seller who cannot see what the rule would have done to the last month of
// real offers is being asked to trust a percentage they typed against data they
// have not looked at.
//
// This is only possible at all because US-2939 started storing offers. Before
// that there was no history to run a rule against.

interface OfferDryRunLine {
  externalOfferId: string;
  decision: "accept" | "counter" | "decline" | "skip";
  copy: string;
  counterPrice: number | null;
}

interface OfferDryRunResult {
  days: number;
  considered: number;
  wouldAccept: number;
  wouldCounter: number;
  wouldDecline: number;
  skipped: number;
  lines: OfferDryRunLine[];
}

function OfferRulePreview({
  acceptAtPct,
  counterAtPct,
  declineBelowPct,
  marginFloorPct,
}: {
  acceptAtPct: string;
  counterAtPct: string;
  declineBelowPct: string;
  marginFloorPct: string;
}) {
  const [preview, setPreview] = useState<OfferDryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const num = (v: string) => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const canPreview =
    num(acceptAtPct) != null || num(counterAtPct) != null || num(declineBelowPct) != null;

  async function run() {
    setRunning(true);
    setPreview(null);
    try {
      const res = await edgeFetch("/api/flipdesk/ebay/negotiation/rule-dry-run", {
        method: "POST",
        body: JSON.stringify({
          accept_at_pct: num(acceptAtPct),
          counter_at_pct: num(counterAtPct),
          decline_below_pct: num(declineBelowPct),
          margin_floor_pct: num(marginFloorPct),
          days: 30,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "The preview failed.");
      setPreview(json as OfferDryRunResult);
    } catch (err) {
      toastError(err, "Couldn't run the preview.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!canPreview || running}
        onClick={run}
      >
        {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Show me what this would have done
      </Button>
      {preview && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <p className="text-sm">
            Over the last {preview.days} days: {preview.considered} offer
            {preview.considered === 1 ? "" : "s"}, {preview.wouldAccept} accepted,{" "}
            {preview.wouldCounter} countered, {preview.wouldDecline} declined,{" "}
            {preview.skipped} left for you.
          </p>
          {preview.considered === 0 && (
            <p className="text-xs text-muted-foreground">
              No offers on record for this window yet, so there is nothing to
              check the rule against. Offers start being recorded from the first
              time we read them.
            </p>
          )}
          {preview.lines.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {preview.lines.map((l) => (
                <li key={l.externalOfferId}>
                  <span className="font-medium">{l.externalOfferId}</span> — {l.copy}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
