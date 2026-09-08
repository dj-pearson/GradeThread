import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError } from "@/lib/toast-error";
import {
  MAX_AGED_THRESHOLD_DAYS,
  MIN_AGED_THRESHOLD_DAYS,
  totalCapitalTiedUp,
} from "@/lib/aged-inventory";
import { useSetAgedThreshold } from "@/hooks/use-aged-threshold";
import type { ItemFullRow } from "@/types/database";

// US-3195: what "too long" means, and what it is costing.
//
// The threshold is the seller's own and is STORED, so this control writes it
// rather than holding it in component state: a definition of aged that resets
// every visit is one they re-type before they can act on it.
//
// THE MONEY FIGURE IS OVER THIS PAGE, AND SAYS SO. The rows are paged
// server-side, so summing them gives the capital in the rows on screen, not in
// the whole aged set. Labelling it "on this page" is the difference between a
// useful number and a wrong one, and the alternative — a second aggregate query
// — is a cost this strip does not need to earn its place.

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function AgedStrip({
  rows,
  thresholdDays,
}: {
  rows: readonly ItemFullRow[];
  thresholdDays: number;
}) {
  const [draft, setDraft] = useState(String(thresholdDays));
  const setThreshold = useSetAgedThreshold();

  // The stored value wins whenever it changes underneath, so the input shows
  // the threshold actually in force rather than a stale keystroke.
  useEffect(() => {
    setDraft(String(thresholdDays));
  }, [thresholdDays]);

  const { total, unknownCount } = totalCapitalTiedUp(rows);

  async function save() {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      toast.error("Enter a number of days.");
      return;
    }
    try {
      await setThreshold.mutateAsync(next);
      toast.success(`Aged now means listed over ${Math.floor(next)} days.`);
    } catch (err) {
      toastError(err, "Could not save that threshold.");
    }
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border p-3">
      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="aged-threshold" className="flex items-center gap-1.5">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" />
            Aged means listed over
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="aged-threshold"
              type="number"
              inputMode="numeric"
              min={MIN_AGED_THRESHOLD_DAYS}
              max={MAX_AGED_THRESHOLD_DAYS}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">days</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={save}
              disabled={setThreshold.isPending || draft === String(thresholdDays)}
            >
              {setThreshold.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
      <div className="text-sm">
        <span className="text-muted-foreground">Money asleep on this page: </span>
        <span className="font-semibold tabular-nums">{money(total)}</span>
        {unknownCount > 0 ? (
          <span className="text-muted-foreground">
            {" "}
            ({unknownCount} with no cost recorded)
          </span>
        ) : null}
      </div>
    </div>
  );
}
