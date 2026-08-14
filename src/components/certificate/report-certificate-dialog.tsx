import { useState } from "react";
import { Flag, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CERTIFICATE_REPORT_REASONS,
  CERTIFICATE_REPORT_NOTE_MAX,
  type CertificateReportReason,
} from "@/lib/certificate-report";
import { edgeApiUrl } from "@/lib/edge-api";

/**
 * US-2550: what a buyer can DO about a certificate they are told not to trust.
 *
 * The integrity panel's worst verdict — "do not trust this certificate" — used
 * to end there. This is the way out: a report filed against the certificate id
 * the buyer is holding, landing in the moderation queue operators already drain.
 *
 * ANONYMOUS by design. The person best placed to report a forged certificate is
 * a buyer on a marketplace who has no GradeThread account and will not create
 * one to complain about us. Nothing about the reporter is sent or stored — only
 * the reason they picked and whatever they choose to type.
 */
export function ReportCertificateDialog({
  certificateId,
  /** Softer wording for the "could not be confirmed" state, which is not an accusation. */
  tone = "alarm",
}: {
  certificateId: string;
  tone?: "alarm" | "caution";
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CertificateReportReason | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!reason || sending) return;
    setSending(true);
    try {
      const res = await fetch(
        `${edgeApiUrl()}/api/content/public/certificates/${encodeURIComponent(certificateId)}/report`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason, note: note.trim() || null }),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      setSent(true);
    } catch {
      // Told plainly, because what the buyer does next depends on whether the
      // report actually went anywhere.
      toast.error("We couldn't file that report. Please email support instead.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setSent(false);
          setReason(null);
          setNote("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={tone === "alarm" ? "destructive" : "outline"}
          className="gap-1.5"
        >
          <Flag className="h-3.5 w-3.5" />
          Report this certificate
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {sent ? (
          <>
            <DialogHeader>
              <DialogTitle>Report received</DialogTitle>
              <DialogDescription>
                A GradeThread reviewer will look at this certificate. You do not
                need to do anything else, and we have not recorded who you are.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Report this certificate</DialogTitle>
              <DialogDescription>
                Tell us what looks wrong. This goes to a GradeThread reviewer,
                not to the seller.
              </DialogDescription>
            </DialogHeader>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What is wrong?</legend>
              {(
                Object.keys(CERTIFICATE_REPORT_REASONS) as CertificateReportReason[]
              ).map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={key}
                    checked={reason === key}
                    onChange={() => setReason(key)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span>{CERTIFICATE_REPORT_REASONS[key]}</span>
                </label>
              ))}
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="report-note">Anything else? (optional)</Label>
              <Textarea
                id="report-note"
                value={note}
                maxLength={CERTIFICATE_REPORT_NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What you saw, and where you saw this certificate."
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Do not include personal details. {note.length}/
                {CERTIFICATE_REPORT_NOTE_MAX}
              </p>
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" size="sm" asChild>
                <a href="mailto:support@gradethread.com">
                  <Mail className="mr-1.5 h-3.5 w-3.5" />
                  Email support instead
                </a>
              </Button>
              <Button onClick={submit} disabled={!reason || sending}>
                {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send report
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
