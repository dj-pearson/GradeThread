import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2543 AC5. This used to live on the Referrals page, where it was the third
// of three code boxes and the only one that had nothing to do with referring
// anybody: a campaign code comes from a GradeThread promotion, not a friend.
// What it actually does is add grade credits, so it belongs beside the credit
// balance.
//
// Both credit surfaces are invalidated on success, because the seller can be
// looking at either one when the code lands.
export function PromoCodeRedeemer() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const redeem = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setRedeeming(true);
    try {
      const res = await edgeFetch("/api/referrals/campaign-codes/redeem", {
        method: "POST",
        json: { code: trimmed },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't redeem that code.");
        return;
      }
      toast.success(
        json.credits > 0
          ? `${json.credits} bonus grade credits added!`
          : "Campaign code applied!",
      );
      setCode("");
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
      qc.invalidateQueries({ queryKey: ["referrals-me"] });
    } catch (err) {
      toastError(err, "Couldn't redeem that code.");
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="promo-code" className="flex items-center gap-2 text-sm font-medium">
        <Ticket className="h-4 w-4 text-brand-red-text" />
        Have a promo code?
      </Label>
      <div className="flex gap-2">
        <Input
          id="promo-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. THRIFT10"
          className="font-mono"
        />
        <Button
          variant="outline"
          onClick={() => void redeem()}
          disabled={!code.trim() || redeeming}
        >
          {redeeming ? "Applying…" : "Apply"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Codes from a GradeThread promotion add bonus grade credits. A friend's
        referral code goes on the Referrals page instead.
      </p>
    </div>
  );
}
