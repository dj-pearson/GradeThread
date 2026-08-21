import { useRef, useState } from "react";
import { Loader2, Paperclip, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useEbayReturnEvidencePlan,
  useEbaySendReturnEvidence,
  type ReturnEvidencePlan,
} from "@/hooks/use-ebay";

// US-2706 AC5: the seller reads the pack before eBay does.
//
// Nothing here sends on a timer and nothing sends on mount. The plan is a READ
// — it calls no eBay endpoint — and the send is a separate button behind a
// separate click, because the interesting outcome of this feature is the one
// where we tell the seller NOT to fight.
//
// THE HONESTY RULE (US-2703 AC3): no copy in this file says the evidence wins
// the case. eBay decides. What GradeThread offers is dated, specific evidence
// in one click instead of a screenshot and a paragraph, and that is what the
// wording claims.

const VERDICT_LABEL: Record<string, string> = {
  contradicted: "Your listing disclosed this",
  supported: "Your report agrees with the buyer",
  not_covered: "Your report doesn't cover this",
};

export function ReturnEvidencePanel({
  caseId,
  orderId,
  kind,
}: {
  caseId: string;
  /** Null when the case carries no order id — nothing to look the item up by. */
  orderId: string | null;
  /**
   * US-2707: which eBay surface this is. It changes the send endpoint and
   * nothing else — the plan, the refusal and the wording are the same question
   * asked of the same grade report, and a second panel would be a second place
   * for the refusal to go missing.
   */
  kind: "return" | "dispute";
}) {
  const [complaint, setComplaint] = useState("");
  const [plan, setPlan] = useState<ReturnEvidencePlan | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useEbayReturnEvidencePlan();
  const send = useEbaySendReturnEvidence();

  if (!orderId) {
    return (
      <p className="text-xs text-muted-foreground">
        This {kind === "return" ? "return" : "dispute"} has no order id, so we
        can't find the graded item behind it.
      </p>
    );
  }

  async function check() {
    setPlan(null);
    try {
      setPlan(
        await preview.mutateAsync({
          orderId: orderId!,
          complaint: complaint.trim(),
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read the plan.");
    }
  }

  async function submit() {
    try {
      const res = await send.mutateAsync({
        caseId,
        kind,
        orderId: orderId!,
        complaint: complaint.trim(),
        files,
      });
      // The removed count is eBay dropping a file AFTER accepting it, so the
      // pack on the case is smaller than the one just reviewed. Saying "sent"
      // over that is the lie this whole surface exists to avoid.
      if ((res.removed ?? 0) > 0) {
        toast.warning(
          `Sent ${res.attached}, but eBay dropped ${res.removed}. Check the case.`,
        );
      } else {
        toast.success(`Sent ${res.attached} to eBay. They decide the case.`);
      }
      setFiles([]);
      setPlan(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "eBay rejected the evidence.");
    }
  }

  const refuses = plan?.verdict === "supported";

  return (
    <div className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`complaint-${caseId}`} className="text-xs">
          What the buyer said
        </Label>
        <Textarea
          id={`complaint-${caseId}`}
          value={complaint}
          onChange={(e) => setComplaint(e.target.value)}
          rows={2}
          placeholder="Paste the buyer's own words from the case."
          className="text-sm"
        />
      </div>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!complaint.trim() || preview.isPending}
        onClick={check}
      >
        {preview.isPending ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="mr-1 h-4 w-4" />
        )}
        Check my grade report
      </Button>

      {plan && !plan.available && (
        <p className="text-xs text-muted-foreground">
          No grade report is linked to this order, so there's nothing to argue
          from. You can still respond on eBay yourself.
        </p>
      )}

      {plan?.available && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {VERDICT_LABEL[plan.verdict ?? ""] ?? "Checked"}
            </span>
            {plan.certificateNumber && (
              <Badge variant="outline" className="text-[10px]">
                {plan.certificateNumber}
              </Badge>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {plan.reason}
          </p>

          {/* US-2706 AC6: a pack with no published listing text on file can
              only argue from the grade report. Said out loud, and BEFORE the
              send button, rather than presented as the same thing. */}
          {plan.hasPublicationSnapshot === false && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              We don't have a copy of what this listing said when it was
              published, so this is the weaker case: the report can show the
              flaw was documented, but not that the listing disclosed it.
            </p>
          )}

          {(plan.citations?.length ?? 0) > 0 && (
            <ul className="space-y-1.5">
              {plan.citations!.map((cite, i) => (
                <li key={i} className="text-xs leading-relaxed">
                  <span className="font-medium">
                    {cite.severity} {cite.defectType.replace(/_/g, " ")} ·{" "}
                    {cite.location}
                  </span>
                  <br />
                  <span className="text-muted-foreground">
                    Report: “{cite.reportText}”
                  </span>
                  <br />
                  <span className="text-muted-foreground">
                    Listing {cite.disclosedIn === "aspects" ? "specifics" : "description"}:
                    {" "}“{cite.disclosureQuote}”
                  </span>
                </li>
              ))}
            </ul>
          )}

          {!refuses && (
            <>
              <p className="text-xs text-muted-foreground">
                {plan.includesConditionSheet
                  ? "The pack sends a condition sheet with your certificate number and grade date"
                  : "This grade isn't certified, so the pack sends no condition sheet"}
                {files.length > 0
                  ? `, plus ${files.length} photo${files.length === 1 ? "" : "s"}.`
                  : ". Add the photos you want to include."}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png"
                multiple
                className="hidden"
                onChange={(e) => {
                  setFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="mr-1 h-4 w-4" />
                  Add photos
                </Button>
                {files.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-xs"
                    onClick={() => setFiles([])}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Clear
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={send.isPending || files.length === 0}
                  onClick={submit}
                >
                  {send.isPending && (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  )}
                  Send to eBay
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
