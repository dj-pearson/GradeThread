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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCancelSubscription } from "@/hooks/use-billing-summary";
import { track } from "@/lib/analytics";
import { PauseSubscriptionDialog } from "@/components/billing/pause-subscription-dialog";
import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";
import { AlertTriangle, Check, Loader2, Pause, TrendingDown } from "lucide-react";

// ── CancelSubscriptionDialog (US-216) ───────────────────────────
//
// Two-step:
//   1. Retention — list what changes/stays, offer off-ramps (pause / downgrade)
//   2. Confirm — required checkbox + optional reason

const CANCEL_REASONS = [
  { value: "too_expensive",    label: "Too expensive" },
  { value: "missing_features", label: "Not enough features" },
  { value: "found_alternative", label: "Found a better tool" },
  { value: "taking_break",     label: "Taking a break" },
  { value: "other",            label: "Other" },
];

interface CancelSubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used for the "your plan ends on …" copy on the confirm step. */
  periodEnd: string | null;
}

export function CancelSubscriptionDialog({
  open,
  onOpenChange,
  periodEnd,
}: CancelSubscriptionDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const cancel = useCancelSubscription();

  function reset() {
    setStep(1);
    setReason("");
    setNotes("");
    setConfirmed(false);
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  function handleConfirm() {
    const fullReason = [reason, notes.trim()].filter(Boolean).join(": ");
    cancel.mutate(
      { reason: fullReason || undefined },
      {
        onSuccess: () => {
          track("subscription.cancel_scheduled", { reason: reason || null });
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  const endsLabel = periodEnd
    ? new Date(periodEnd).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "the end of the current period";

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg">
          {step === 1 ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  Before you cancel
                </DialogTitle>
                <DialogDescription>
                  Your subscription will end on <strong>{endsLabel}</strong>.
                  Until then you keep full access.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-2 text-sm">
                <div className="rounded-md border border-border p-3">
                  <div className="mb-1 font-semibold text-red-700">
                    What changes at period end
                  </div>
                  <ul className="space-y-1 text-muted-foreground">
                    <Bullet>Caps drop to the Free tier</Bullet>
                    <Bullet>Scheduled actions disabled</Bullet>
                    <Bullet>Sub-accounts removed</Bullet>
                    <Bullet>API keys disabled</Bullet>
                  </ul>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="mb-1 font-semibold text-emerald-700">
                    What you keep
                  </div>
                  <ul className="space-y-1 text-muted-foreground">
                    <Bullet keep>Your grade credits (never expire)</Bullet>
                    <Bullet keep>All your inventory + listing data</Bullet>
                    <Bullet keep>Past grade reports + certificates</Bullet>
                  </ul>
                </div>
                <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
                  <div className="mb-2 font-semibold">Try a softer landing</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        handleClose(false);
                        setPauseOpen(true);
                      }}
                    >
                      <Pause className="mr-2 h-4 w-4" />
                      Pause instead
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        handleClose(false);
                        setPlanPickerOpen(true);
                      }}
                    >
                      <TrendingDown className="mr-2 h-4 w-4" />
                      Switch to cheaper plan
                    </Button>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <Button variant="ghost" onClick={() => handleClose(false)}>
                  Never mind
                </Button>
                <Button variant="destructive" onClick={() => setStep(2)}>
                  Continue to cancel
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Confirm cancellation</DialogTitle>
                <DialogDescription>
                  Your plan ends on <strong>{endsLabel}</strong>. Help us
                  improve — why are you leaving?
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Reason (optional)</Label>
                  <Select value={reason} onValueChange={setReason}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick one…" />
                    </SelectTrigger>
                    <SelectContent>
                      {CANCEL_REASONS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Anything specific? (optional)</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="What could we have done better?"
                    rows={3}
                    maxLength={500}
                  />
                </div>

                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    I understand my plan ends on <strong>{endsLabel}</strong>{" "}
                    and I'll lose access to {/* paid features */}
                    bulk actions, scheduling, AI comps, and other paid
                    features at that time.
                  </span>
                </label>
              </div>

              <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleConfirm}
                  disabled={!confirmed || cancel.isPending}
                >
                  {cancel.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Cancel my subscription
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <PauseSubscriptionDialog open={pauseOpen} onOpenChange={setPauseOpen} />
      <FlipdeskPlanPickerDialog
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
      />
    </>
  );
}

function Bullet({ children, keep }: { children: React.ReactNode; keep?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      {keep ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
      )}
      <span>{children}</span>
    </li>
  );
}
