import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import {
  closePeriod,
  fetchClosedPeriods,
  reopenPeriod,
  type ClosedPeriod,
} from "@/lib/period-close";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  fiscalYearLabel,
} from "@/lib/tax-profile";

// US-2995 — closing a year.
//
// The enforcement is in the database, not here. This screen exists to make the
// decision legible: what closing actually stops, what it does not, and how to
// correct something afterwards without rewriting history.

export function PeriodCloseCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [reopening, setReopening] = useState<ClosedPeriod | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const fyStart =
    profile?.fiscal_year_start_month ??
    TAX_PROFILE_DEFAULTS.fiscal_year_start_month;

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ["closed-periods", user?.id],
    enabled: !!user,
    queryFn: fetchClosedPeriods,
  });

  // The FISCAL year, not the calendar one: closing follows the seller's own
  // year, because that is the period they filed.
  const from = `${year}-${String(fyStart).padStart(2, "0")}-01`;
  const to = `${year + 1}-${String(fyStart).padStart(2, "0")}-01`;
  const label = fiscalYearLabel(new Date(year, fyStart - 1, 1), fyStart);
  const alreadyClosed = periods.some(
    (p) => p.reopened_at === null && p.period_start === from,
  );

  async function doClose() {
    const ok = await confirm({
      title: `Close ${label}?`,
      description:
        "After this, the money in that year stops moving: expenses, mileage, sale amounts and item costs are frozen. Shipping, tracking and renaming still work. You can reopen it later with a reason.",
      confirmLabel: `Close ${label}`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await closePeriod(from, to, label);
      await qc.invalidateQueries({ queryKey: ["closed-periods"] });
      await qc.invalidateQueries({ queryKey: ["cogs-worksheet"] });
      toast.success(
        `${label} is closed. Inventory was counted at the same time.`,
      );
    } catch (err) {
      toastError(err, "Couldn't close that year.");
    } finally {
      setBusy(false);
    }
  }

  async function doReopen() {
    if (!reopening) return;
    if (reason.trim() === "") {
      toast.error("Say why. A reopen without a reason is not a record.");
      return;
    }
    setBusy(true);
    try {
      await reopenPeriod(reopening.id, reason.trim());
      await qc.invalidateQueries({ queryKey: ["closed-periods"] });
      setReopening(null);
      setReason("");
      toast.success("Reopened. The change is on the record.");
    } catch (err) {
      toastError(err, "Couldn't reopen that.");
    } finally {
      setBusy(false);
    }
  }

  const years = [1, 2, 3].map((n) => new Date().getFullYear() - n);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Closing a year</CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Once you have filed, the numbers for that year should stop moving.
          Closing it makes that true rather than a promise.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="pc-year" className="text-xs">
              Year
            </Label>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger id="pc-year" className="h-9 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={doClose} disabled={busy || alreadyClosed}>
            <Lock className="mr-2 h-4 w-4" />
            {alreadyClosed ? "Already closed" : `Close ${label}`}
          </Button>
        </div>

        {/* A lock nobody understands gets reopened on the first refusal. Saying
            plainly what stops and what does not is the difference between a
            seller trusting the close and fighting it. */}
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">What closing stops</p>
          <ul className="mt-1.5 space-y-0.5 text-[13px] leading-relaxed text-muted-foreground">
            <li>Editing or deleting an expense dated in that year</li>
            <li>Backdating a new expense or trip into it</li>
            <li>Changing a sale's price, fees, shipping or tax</li>
            <li>Changing what an item cost, if it sold in that year</li>
          </ul>
          <p className="mt-2 text-sm font-medium">What still works</p>
          <ul className="mt-1.5 space-y-0.5 text-[13px] leading-relaxed text-muted-foreground">
            <li>Shipping, tracking and delivery on an old sale</li>
            <li>Renaming items, photos, measurements, listings</li>
            <li>Everything in the years you have not closed</li>
          </ul>
          <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            Found something wrong afterwards? Add it to the open year as a
            correction, or reopen the year below and say why.
          </p>
        </div>

        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : periods.length > 0 ? (
          <ul className="space-y-2">
            {periods.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm">
                    {p.label}
                    {p.reopened_at ? (
                      <span className="ml-2 text-[13px] text-amber-700 dark:text-amber-400">
                        reopened
                      </span>
                    ) : (
                      <span className="ml-2 text-[13px] text-muted-foreground">
                        closed
                      </span>
                    )}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {p.reopened_at
                      ? `${new Date(p.reopened_at).toLocaleDateString()} — ${p.reopen_reason}`
                      : `Closed ${new Date(p.closed_at).toLocaleDateString()}`}
                  </p>
                </div>
                {!p.reopened_at && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setReopening(p);
                      setReason("");
                    }}
                  >
                    <LockOpen className="mr-1.5 h-3.5 w-3.5" />
                    Reopen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No years closed yet.
          </p>
        )}
      </CardContent>

      <Dialog open={!!reopening} onOpenChange={(o) => !o && setReopening(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopening?.label}?</DialogTitle>
            <DialogDescription>
              The figures from when you closed it are kept, so you can compare.
              We record who reopened it and why.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="pc-reason">Why are you reopening it?</Label>
            <Input
              id="pc-reason"
              placeholder="Found a receipt for March that was never logged"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopening(null)}>
              Cancel
            </Button>
            <Button onClick={doReopen} disabled={busy || reason.trim() === ""}>
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
