import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Split } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { formatCents } from "@/lib/ledger-math";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  canSplitByLine,
  pairInOrder,
  planFromAmounts,
  planFromLines,
  planProblems,
  refusalForGap,
  remainderExpense,
  splitEvenly,
  type AllocationPlan,
  type ReceiptLine,
} from "@/lib/receipt-allocation";
import {
  applyAllocation,
  createRemainderExpense,
  fetchAcquisitionCandidates,
} from "@/lib/receipt-allocation-data";

// US-3012 — the owner's idea, and it attacks the worst issue in the books-health
// queue: items sold with no cost basis, which overstate profit by exactly the
// figure nobody recorded.
//
// A thrift receipt describes nothing useful, so this NEVER tries to match a line
// to an item by its description. It shows the lines, shows the items bought that
// day, and lets the seller say which is which -- fifteen seconds of work that a
// computer does badly.

const UNASSIGNED = "__none";

export function ReceiptSplitCard({
  lines,
  totalCents,
  vendor,
  spentOn,
  linesGapCents,
  onDone,
}: {
  lines: ReceiptLine[];
  totalCents: number;
  vendor: string | null;
  spentOn: string;
  /** linesReconcile(): total less tax less the sum of the lines. */
  linesGapCents: number | null;
  onDone?: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const [assignments, setAssignments] = useState<Record<number, string | null>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ["acquisition-candidates", user?.id, spentOn],
    enabled: !!user,
    queryFn: () => fetchAcquisitionCandidates(spentOn),
    staleTime: 60 * 1000,
  });

  // AC3. A gap means a line was missed, so a per-line split would put a WRONG
  // price on every item. The whole-total path stays available, because that
  // number WAS read.
  const refusal = refusalForGap(linesGapCents);
  const byLine = lines.length > 0 && canSplitByLine(linesGapCents);

  const plan: AllocationPlan = useMemo(() => {
    if (byLine) return planFromLines(lines, candidates, assignments);
    const typed = Object.entries(amounts).reduce<Record<string, number>>(
      (acc, [id, text]) => {
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) acc[id] = Math.round(n * 100);
        return acc;
      },
      {},
    );
    if (Object.keys(typed).length > 0) return planFromAmounts(totalCents, candidates, typed);
    return splitEvenly(totalCents, chosen);
  }, [byLine, lines, candidates, assignments, amounts, totalCents, chosen]);

  const problems = planProblems(plan, totalCents);
  const leftover = remainderExpense(plan, vendor, spentOn);
  const inOrder = byLine ? pairInOrder(lines, candidates) : null;

  async function save() {
    if (!user || problems.length > 0) return;
    setSaving(true);
    try {
      const result = await applyAllocation(plan);
      if (leftover) {
        try {
          await createRemainderExpense(user.id, leftover);
        } catch (err) {
          // The cost bases are the point; the leftover is bookkeeping. Losing
          // the expense must not undo work the seller just did by hand.
          toastError(err, "Prices saved, but the leftover expense wasn't created.");
        }
      }
      if (result.failed.length > 0) {
        toast.warning(
          `${result.updated} saved, ${result.failed.length} didn't. Try those again.`,
        );
      } else {
        toast.success(
          `${result.updated} item${result.updated === 1 ? "" : "s"} now has a real cost.`,
        );
      }
      onDone?.();
    } catch (err) {
      toastError(err, "Couldn't save the split.");
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Split this receipt across your items</CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          An item sold with no purchase price overstates your profit by exactly
          the figure nobody wrote down. You know which shirt was $2.99, so this
          asks rather than guesses.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {refusal && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[13px] leading-relaxed">
            {refusal.message}
          </p>
        )}

        {isLoading && (
          <p className="text-[13px] text-muted-foreground">
            Looking for what you bought around {spentOn}.
          </p>
        )}

        {!isLoading && candidates.length === 0 && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Nothing was added to your inventory within a few days of {spentOn}, so
            there is nothing to split this across yet.
          </p>
        )}

        {candidates.length > 0 && byLine && (
          <>
            {/* AC2. Thrift receipts print in the order things came off the
                counter, which is often the order they were photographed. Right
                often enough for one tap, wrong often enough that the seller
                confirms it rather than having it applied for them. */}
            {inOrder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setAssignments(
                    Object.fromEntries(inOrder.map((a, i) => [i, a.item_id])),
                  )}
              >
                <Split className="mr-2 h-4 w-4" />
                These {lines.length} lines are these {lines.length} items, in order
              </Button>
            )}

            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 shrink-0 tabular-nums text-[13px] font-medium">
                    {formatCents(line.amount_cents)}
                  </span>
                  <span className="w-32 shrink-0 truncate text-[13px] text-muted-foreground">
                    {/* Copied verbatim however useless. "RED ITEM" is what the
                        receipt says, and rewriting it would hide that. */}
                    {line.description ?? "no description"}
                  </span>
                  <Select
                    value={assignments[index] ?? UNASSIGNED}
                    onValueChange={(v) =>
                      setAssignments({
                        ...assignments,
                        [index]: v === UNASSIGNED ? null : v,
                      })}
                  >
                    <SelectTrigger
                      className="h-8 w-full max-w-[280px]"
                      aria-label={`Item for the ${formatCents(line.amount_cents)} line`}
                    >
                      <SelectValue placeholder="Not an item" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>Not an item</SelectItem>
                      {candidates.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.title}
                          {c.acquired_price_cents != null
                            ? ` (has ${formatCents(c.acquired_price_cents)})`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </>
        )}

        {candidates.length > 0 && !byLine && (
          <>
            {/* AC7. A handwritten estate-sale receipt reads as a total and
                nothing else, and that is the common case rather than the edge
                one. Pick the items and either divide it or type the amounts. */}
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This receipt reads as one total of {formatCents(totalCents)}. Pick
              the items it paid for, or type what each one cost.
            </p>
            <div className="space-y-2">
              {candidates.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2">
                  <label className="flex flex-1 items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={chosen.includes(c.id)}
                      onChange={(e) =>
                        setChosen(
                          e.target.checked
                            ? [...chosen, c.id]
                            : chosen.filter((x) => x !== c.id),
                        )}
                    />
                    {c.title}
                  </label>
                  <div className="space-y-1">
                    <Label htmlFor={`amt-${c.id}`} className="sr-only">
                      What {c.title} cost
                    </Label>
                    <Input
                      id={`amt-${c.id}`}
                      value={amounts[c.id] ?? ""}
                      onChange={(e) =>
                        setAmounts({ ...amounts, [c.id]: e.target.value })}
                      placeholder="or type"
                      inputMode="decimal"
                      className="h-8 w-24"
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {plan.overwrites.length > 0 && (
          <p className="flex items-start gap-2 text-[13px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
            {plan.overwrites.length} of these already had a price. Saving replaces
            it.
          </p>
        )}

        {problems.length > 0 && (
          <ul className="space-y-1 text-[13px] leading-relaxed text-destructive">
            {problems.map((p) => (
              <li key={p.kind}>{p.message}</li>
            ))}
          </ul>
        )}

        {/* AC4. One expense, never smeared. Smearing makes every cost basis
            slightly wrong and untraceable. */}
        {leftover && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {formatCents(leftover.amount_cents)} is left over. It becomes one
            expense called "{leftover.description}", not spread across the items.
          </p>
        )}

        <Button
          onClick={save}
          disabled={saving || problems.length > 0 || candidates.length === 0}
        >
          {saving ? "Saving" : "Set these prices"}
        </Button>
      </CardContent>
    </Card>
  );
}
