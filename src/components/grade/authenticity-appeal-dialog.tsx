import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2145: the seller's way to contest an authenticity verdict.
//
// Everything behind this button already existed — POST /api/grade/
// authenticity-appeal verifies ownership, rate-limits, files the dispute,
// HIDES the verdict, and reseals the certificate; the admin queue and resolve
// routes were built too. What did not exist was any way for a seller to reach
// it: a grep for the endpoint across src/ returned zero hits. So the appeals
// queue could only ever be empty, and a seller whose genuine item was flagged
// had exactly the problem the story title describes.
//
// The minimum length is enforced here AND on the server (validateAppeal). The
// client copy is the useful half — it tells the seller what a reviewer needs
// before they type, rather than rejecting them after.

/** The server's floor, mirrored so the seller learns it before submitting. */
const MIN_REASON = 20;
const MAX_REASON = 2000;

export function AuthenticityAppealDialog({
  gradeReportId,
  open,
  onOpenChange,
  onFiled,
}: {
  gradeReportId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called after a successful file so the caller can refetch the report. */
  onFiled: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const tooShort = reason.trim().length < MIN_REASON;

  async function submit() {
    if (tooShort) return;
    setSaving(true);
    try {
      const res = await edgeFetch("/api/grade/authenticity-appeal", {
        method: "POST",
        json: { gradeReportId, reason: reason.trim() },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // 429 is the deliberate open-appeal cap, not a transient failure — the
        // server's message explains it, so surface that rather than a generic
        // retry prompt that would send the seller round the same loop.
        toast.error(json.error ?? "Couldn't file the appeal.");
        return;
      }
      toast.success("Appeal filed", {
        description:
          "The authenticity result is hidden while a human reviews it. We'll let you know the outcome.",
      });
      setReason("");
      onOpenChange(false);
      onFiled();
    } catch {
      toast.error("Couldn't file the appeal. Check your connection and retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            Contest this authenticity result
          </DialogTitle>
          <DialogDescription>
            A human reviewer will look at your item again. While the appeal is
            open the authenticity result is hidden — it will not show on your
            certificate or to buyers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="appeal-reason">
            What should the reviewer know?
          </Label>
          <Textarea
            id="appeal-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON))}
            rows={5}
            placeholder="Where you bought it, any receipt or proof of purchase, and anything about the item the photos may not show."
          />
          {/* Tell them what a reviewer actually needs, before they type. The
              server enforces the same floor; being rejected after writing is a
              worse way to learn it. */}
          <p className="text-xs text-muted-foreground">
            {tooShort
              ? `At least ${MIN_REASON} characters — specifics help far more than "this is genuine".`
              : `${reason.trim().length} / ${MAX_REASON}`}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || tooShort}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            File appeal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
