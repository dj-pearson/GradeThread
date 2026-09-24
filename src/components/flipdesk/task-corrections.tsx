// Worth My Time, R2 05/06 (US-3182): the controls a seller corrects us with.
//
// ── A NATIVE DISCLOSURE, NOT A MODAL (AC7) ──────────────────────────────────
// A <details>, the same choice WhyThisTask made and for the same reasons: it
// is reachable and operable from the keyboard with no handler of ours, it
// announces its own state to a screen reader, and it degrades to open markup
// when styles fail. A dialog here would also steal focus from a seller who is
// halfway down a list with a garment in one hand.
//
// ── THE DIFFERENCE IS SHOWN BEFORE IT IS SAVED (AC2) ────────────────────────
// Typing a new number recomputes what the plan would say and prints it under
// the field. A seller who corrects one duration and finds three other jobs
// gone has been given a different plan without being asked, and the next
// thing they do is stop correcting things.
//
// ── NOTHING HERE TOUCHES THE ITEM (AC1) ─────────────────────────────────────
// Every control on this panel writes to the planner's own tables through
// /planner/overrides and /planner/suppressions. No price, no grade, no
// status, nothing the books read. The garment's own screens own those.

import { useId, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError } from "@/lib/toast-error";
import {
  useResetOverride,
  useResetSuppression,
  useSaveOverride,
  useSuppress,
  useWorkOverrides,
} from "@/hooks/use-planner";
import {
  costOverrideFor,
  decideMinutes,
  differenceFromOverride,
  dollarsToCents as toCents,
  emptyBook,
  minutesOverrideFor,
  suppressionVerdictFor,
  validateOverride,
  valueOverrideFor,
  type OverrideBook,
  type OverrideKind,
  type SuppressionKind,
} from "@/lib/work-overrides";
import {
  OVERRIDE_ERROR_COPY,
  SNOOZE_EXPIRED_COPY,
  SUPPRESSION_COPY,
  SUPPRESSION_STATE_COPY,
  URGENT_OVERRIDES_SUPPRESSION_COPY,
} from "@/lib/work-overrides-copy";

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

function Errors({ id, codes }: { id: string; codes: readonly string[] }) {
  if (codes.length === 0) return null;
  return (
    <ul id={id} role="alert" className="text-xs text-destructive">
      {codes.map((c) => (
        <li key={c}>
          {OVERRIDE_ERROR_COPY[c as keyof typeof OVERRIDE_ERROR_COPY] ?? c}
        </li>
      ))}
    </ul>
  );
}

/**
 * The stored set-asides of one kind that are parking this task: item-wide or
 * this step, and for a skip, this session only. Distinct by the two keys the
 * reset route narrows on.
 */
function parkingRows(
  book: OverrideBook,
  args: {
    itemId: string;
    actionKey: string;
    sessionId?: string | null;
    kind: SuppressionKind;
  },
): Array<{ actionKey: string | null; sessionId: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ actionKey: string | null; sessionId: string | null }> = [];
  for (const s of book.suppressions) {
    if (s.inventoryItemId !== args.itemId || s.kind !== args.kind) continue;
    if (s.actionKey !== null && s.actionKey !== args.actionKey) continue;
    if (s.kind === "skip_session" && s.sessionId !== (args.sessionId ?? null)) continue;
    const key = `${s.actionKey ?? ""}|${s.sessionId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ actionKey: s.actionKey, sessionId: s.sessionId });
  }
  return out;
}

export interface TaskCorrectionsProps {
  itemId: string;
  actionKey: string;
  /** What the planner says today, before any correction. Null when unknown. */
  estimateMinutes: number | null;
  /** Minutes still unspent in the plan on screen, for the fit warning. */
  remainingBudgetMinutes: number;
  /**
   * What the plan already charges this task (WMT-04), so the fit warning asks
   * whether the GROWTH fits rather than the whole new number.
   */
  chargedMinutes?: number;
  /** The open session, so a skip applies to this sitting and no other. */
  sessionId?: string | null;
  /** True when the ranker calls this an urgent shipment (AC3). */
  urgentShipping?: boolean;
  /** Fired after any change lands, so the page can offer a fresh plan. */
  onChanged?: () => void;
}

/**
 * WMT-08: KEYED ON THE TASK. The runner shows one task after another in the
 * same place, and the fields used to be seeded once, so the minutes typed for
 * one garment were still in the box for the next. A new key is a fresh panel.
 */
export function TaskCorrections(props: TaskCorrectionsProps) {
  return <CorrectionsPanel key={`${props.itemId}:${props.actionKey}`} {...props} />;
}

function CorrectionsPanel({
  itemId,
  actionKey,
  estimateMinutes,
  remainingBudgetMinutes,
  chargedMinutes,
  sessionId,
  urgentShipping,
  onChanged,
}: TaskCorrectionsProps) {
  // WMT-08: the LIVE corrections, not the book the plan was built with. A
  // save or a set-aside invalidates this query, so "Use our estimate" and
  // "Put it back" appear the moment the change lands instead of after a
  // rebuild. A failed read is an empty book: the controls still work.
  const overrides = useWorkOverrides();
  const fallbackBook = useMemo(() => emptyBook(new Date().toISOString()), []);
  const book: OverrideBook = overrides.data ?? fallbackBook;
  const uid = useId();
  const ids = {
    minutes: `${uid}-min`,
    minutesErr: `${uid}-min-err`,
    low: `${uid}-low`,
    high: `${uid}-high`,
    valueErr: `${uid}-value-err`,
    cost: `${uid}-cost`,
    costErr: `${uid}-cost-err`,
  };

  const savedMinutes = minutesOverrideFor(book, itemId, actionKey);
  const savedValue = valueOverrideFor(book, itemId);
  const savedCost = costOverrideFor(book, itemId);
  const verdict = suppressionVerdictFor(book, {
    itemId,
    actionKey,
    sessionId,
    urgentShipping,
  });
  // What the row says regardless of the urgent override, so a seller can put
  // a snooze back even on the evening the parcel outranked it.
  const parked = suppressionVerdictFor(book, { itemId, actionKey, sessionId });

  const [minutes, setMinutes] = useState(savedMinutes != null ? String(savedMinutes) : "");
  const [low, setLow] = useState(dollars(savedValue?.lowCents));
  const [high, setHigh] = useState(dollars(savedValue?.highCents));
  const [cost, setCost] = useState(dollars(savedCost));
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const save = useSaveOverride();
  const reset = useResetOverride();
  const suppress = useSuppress();
  const unsuppress = useResetSuppression();
  const busy = save.isPending || reset.isPending || suppress.isPending ||
    unsuppress.isPending;

  // AC2: what the plan WOULD say, computed as the seller types and printed
  // before anything is written.
  const typedMinutes = minutes.trim() === "" ? Number.NaN : Number(minutes);
  const preview = Number.isFinite(typedMinutes) && typedMinutes > 0 &&
      estimateMinutes != null
    ? differenceFromOverride({
      key: `${itemId}:${actionKey}`,
      decision: decideMinutes({
        overrideMinutes: typedMinutes,
        learnedMinutes: null,
        defaultMinutes: estimateMinutes,
      }),
      remainingBudgetMinutes,
      chargedMinutes,
    })
    : null;

  function setError(kind: OverrideKind, codes: string[]) {
    setErrors((e) => ({ ...e, [kind]: codes }));
  }

  async function commit(kind: OverrideKind, args: Record<string, number>) {
    const value = kind === "value_range"
      ? { lowCents: args.lowCents, highCents: args.highCents }
      : { amount: args.amountMinutes ?? args.amountCents };
    const checked = validateOverride(kind, value);
    if (!checked.ok) {
      setError(kind, checked.errors);
      return;
    }
    setError(kind, []);
    try {
      await save.mutateAsync({
        inventoryItemId: itemId,
        // Minutes are about THIS step; money is about the garment. Scoping a
        // price to "photograph" would hide it from every other task on the
        // same item.
        actionKey: kind === "task_minutes" ? actionKey : null,
        kind,
        ...args,
        original: kind === "task_minutes" ? { amount: estimateMinutes } : null,
      });
      toast.success("Saved. Build a new plan to use it.");
      onChanged?.();
    } catch (err) {
      toastError(err, "Couldn't save that correction.");
    }
  }

  async function clear(kind: OverrideKind) {
    try {
      await reset.mutateAsync({
        inventoryItemId: itemId,
        actionKey: kind === "task_minutes" ? actionKey : null,
        kind,
      });
      if (kind === "task_minutes") setMinutes("");
      if (kind === "value_range") { setLow(""); setHigh(""); }
      if (kind === "remaining_cost") setCost("");
      setError(kind, []);
      toast.success("Back to our estimate.");
      onChanged?.();
    } catch (err) {
      toastError(err, "Couldn't reset that.");
    }
  }

  async function setAside(kind: SuppressionKind) {
    try {
      await suppress.mutateAsync({
        inventoryItemId: itemId,
        actionKey: kind === "dismiss" ? null : actionKey,
        kind,
        sessionId: kind === "skip_session" ? sessionId ?? null : null,
      });
      // WMT-08: an Undo that resets exactly the row just written, scoped the
      // same way it was saved (WMT-02).
      toast.success(SUPPRESSION_STATE_COPY[kind], {
        action: {
          label: "Undo",
          onClick: () => {
            void unsuppress
              .mutateAsync({
                inventoryItemId: itemId,
                kind,
                actionKey: kind === "dismiss" ? null : actionKey,
                sessionId: kind === "skip_session" ? sessionId ?? null : null,
              })
              .then(() => onChanged?.())
              .catch((err) => toastError(err, "Couldn't undo that."));
          },
        },
      });
      onChanged?.();
    } catch (err) {
      toastError(err, "Couldn't set that aside.");
    }
  }

  async function putBack() {
    if (!parked.suppressed) return;
    const kind = parked.reason;
    // WMT-02: undo the set-aside this panel SHOWS and no other. Each row that
    // is parking this task under that kind is reset by its own action_key and
    // session_id, so a skip on this step no longer takes the item-wide
    // dismiss or another step's snooze with it.
    const rows = parkingRows(book, { itemId, actionKey, sessionId, kind });
    const targets = rows.length > 0
      ? rows
      : [{ actionKey: kind === "dismiss" ? null : actionKey, sessionId: null }];
    try {
      for (const r of targets) {
        await unsuppress.mutateAsync({
          inventoryItemId: itemId,
          kind,
          actionKey: r.actionKey,
          sessionId: r.sessionId,
        });
      }
      toast.success("Back on the list.");
      onChanged?.();
    } catch (err) {
      toastError(err, "Couldn't undo that.");
    }
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer underline">Change or set aside</summary>
      <div className="mt-2 w-72 space-y-4 rounded-lg bg-muted/50 p-3 text-left">
        {/* AC3: the one line that has to be right. */}
        {verdict.reason === "urgent_shipping_overrides_suppression" && (
          <p role="status" className="font-medium">
            {URGENT_OVERRIDES_SUPPRESSION_COPY}
          </p>
        )}
        {verdict.reason === "snooze_expired" && <p>{SNOOZE_EXPIRED_COPY}</p>}

        {/* WMT-08: each group is a form, so Enter saves it. */}
        <form
          className="space-y-1.5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || minutes.trim() === "") return;
            void commit("task_minutes", { amountMinutes: Number(minutes) });
          }}
        >
          <Label htmlFor={ids.minutes}>How long does this really take?</Label>
          <div className="flex gap-2">
            <Input
              id={ids.minutes}
              data-field="minutes"
              className="w-20"
              inputMode="numeric"
              placeholder={estimateMinutes != null ? String(estimateMinutes) : "20"}
              value={minutes}
              aria-invalid={(errors.task_minutes ?? []).length > 0}
              aria-describedby={(errors.task_minutes ?? []).length > 0
                ? ids.minutesErr
                : undefined}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || minutes.trim() === ""}>
              Save
            </Button>
            {savedMinutes != null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void clear("task_minutes")}
              >
                Use our estimate
              </Button>
            )}
          </div>
          <Errors id={ids.minutesErr} codes={errors.task_minutes ?? []} />
          {preview && preview.beforeMinutes !== preview.afterMinutes && (
            <p className="text-muted-foreground">
              We said about {preview.beforeMinutes} min. You're saying{" "}
              {preview.afterMinutes}.
              {preview.nowDoesNotFit
                ? " That's more than the time left in this plan."
                : ""}
            </p>
          )}
        </form>

        <form
          className="space-y-1.5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || low.trim() === "" || high.trim() === "") return;
            void commit("value_range", {
              lowCents: toCents(low),
              highCents: toCents(high),
            });
          }}
        >
          <Label htmlFor={ids.low}>What do you think it sells for?</Label>
          <div className="flex items-center gap-2">
            <Input
              id={ids.low}
              data-field="low"
              className="w-20"
              inputMode="decimal"
              placeholder="30"
              value={low}
              aria-invalid={(errors.value_range ?? []).length > 0}
              aria-describedby={(errors.value_range ?? []).length > 0
                ? ids.valueErr
                : undefined}
              onChange={(e) => setLow(e.target.value)}
            />
            <span className="text-muted-foreground">to</span>
            <Input
              id={ids.high}
              data-field="high"
              aria-label="Highest it sells for, in dollars"
              className="w-20"
              inputMode="decimal"
              placeholder="50"
              value={high}
              aria-invalid={(errors.value_range ?? []).length > 0}
              aria-describedby={(errors.value_range ?? []).length > 0
                ? ids.valueErr
                : undefined}
              onChange={(e) => setHigh(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || low.trim() === "" || high.trim() === ""}
            >
              Save
            </Button>
            {savedValue && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void clear("value_range")}
              >
                Use our estimate
              </Button>
            )}
          </div>
          <Errors id={ids.valueErr} codes={errors.value_range ?? []} />
          {/* AC1, said out loud where a seller can read it. */}
          <p className="text-muted-foreground">
            Planning only. It doesn't change your listing price.
          </p>
        </form>

        <form
          className="space-y-1.5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || cost.trim() === "") return;
            void commit("remaining_cost", { amountCents: toCents(cost) });
          }}
        >
          <Label htmlFor={ids.cost}>Anything left to spend on it?</Label>
          <div className="flex gap-2">
            <Input
              id={ids.cost}
              data-field="cost"
              className="w-20"
              inputMode="decimal"
              placeholder="0"
              value={cost}
              aria-invalid={(errors.remaining_cost ?? []).length > 0}
              aria-describedby={(errors.remaining_cost ?? []).length > 0
                ? ids.costErr
                : undefined}
              onChange={(e) => setCost(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || cost.trim() === ""}>
              Save
            </Button>
            {savedCost != null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void clear("remaining_cost")}
              >
                Use our estimate
              </Button>
            )}
          </div>
          <Errors id={ids.costErr} codes={errors.remaining_cost ?? []} />
        </form>

        <div className="space-y-1.5">
          <p className="font-medium">Not now</p>
          {parked.suppressed ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground">
                {SUPPRESSION_STATE_COPY[parked.reason]}
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void putBack()}>
                Put it back
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sessionId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setAside("skip_session")}
                >
                  {SUPPRESSION_COPY.skip_session}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void setAside("snooze")}
              >
                {SUPPRESSION_COPY.snooze}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void setAside("dismiss")}
              >
                {SUPPRESSION_COPY.dismiss}
              </Button>
            </div>
          )}
          {/* AC3: nothing here sells, archives or deletes anything. */}
          <p className="text-muted-foreground">
            Setting aside only hides the suggestion. Your item stays where it is.
          </p>
        </div>

        {busy && (
          <p className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving
          </p>
        )}
      </div>
    </details>
  );
}
