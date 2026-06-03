import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePauseSubscription } from "@/hooks/use-billing-summary";
import { track } from "@/lib/analytics";
import { Loader2, Pause } from "lucide-react";

interface PauseSubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const OPTIONS: Array<{ months: 1 | 2 | 3; label: string }> = [
  { months: 1, label: "1 month" },
  { months: 2, label: "2 months" },
  { months: 3, label: "3 months" },
];

export function PauseSubscriptionDialog({
  open,
  onOpenChange,
}: PauseSubscriptionDialogProps) {
  const [selected, setSelected] = useState<1 | 2 | 3>(1);
  const pause = usePauseSubscription();

  function handlePause() {
    pause.mutate(
      { months: selected },
      {
        onSuccess: () => {
          track("subscription.paused", { months: selected });
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pause className="h-5 w-5" />
            Pause subscription
          </DialogTitle>
          <DialogDescription>
            Take a break without losing your data. You won't be charged while
            paused, your caps will fall back to Free, and your credits stay
            untouched. We'll automatically resume when the time is up — or you
            can resume earlier from this page.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2 py-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.months}
              type="button"
              onClick={() => setSelected(opt.months)}
              className={cn(
                "rounded-md border p-3 text-center transition-colors",
                selected === opt.months
                  ? "border-brand-navy bg-brand-navy/5 ring-2 ring-brand-navy/20"
                  : "border-border hover:border-brand-navy/40 hover:bg-muted/40",
              )}
            >
              <div className="text-2xl font-bold tabular-nums">
                {opt.months}
              </div>
              <div className="text-xs text-muted-foreground">
                month{opt.months > 1 ? "s" : ""}
              </div>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handlePause} disabled={pause.isPending}>
            {pause.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Pause for {selected} month{selected > 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
