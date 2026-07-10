import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Camera, Check, Gift, Loader2, Lock, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerPurchases, type PurchaseWithCaptures } from "@/hooks/use-buyer-purchases";
import type { ArrivalImageType } from "@/types/database";

// US-1811: buyer rewards — link a purchase to its GradeThread grade, then snap
// arrival photos to (later, US-1812) confirm it matched. Locked behind the
// `rewards` entitlement. Reads own purchases via RLS; writes go through the edge
// (cert verified server-side; images hardened + private-bucketed).

const ARRIVAL_TYPES: ArrivalImageType[] = ["front", "back", "label", "detail"];

function centsFromDollars(v: string): number | null {
  const n = parseFloat(v);
  return !v.trim() || Number.isNaN(n) || n < 0 ? null : Math.round(n * 100);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// One purchase card with its arrival-capture checklist.
function PurchaseCard({ purchase }: { purchase: PurchaseWithCaptures }) {
  const { uploadArrival, isUploading, confirmPurchase, isConfirming } = useBuyerPurchases();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const captured = new Set(purchase.captures.map((c) => c.image_type));
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");

  async function onPick(type: ArrivalImageType, file: File | undefined) {
    if (!file) return;
    try {
      const data_url = await readAsDataUrl(file);
      await uploadArrival(purchase.id, [{ image_type: type, data_url }]);
      toast.success(`${type} photo saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  }

  async function onConfirm() {
    try {
      const outcome = await confirmPurchase(purchase.id, { match_status: "confirmed" });
      const credits = outcome?.rewardCreditsIssued ?? 0;
      toast.success(
        credits > 0
          ? `Thanks! Grade confirmed — you earned ${credits} reward credit${credits === 1 ? "" : "s"}.`
          : outcome?.trustScore != null
            ? `Thanks! Grade confirmed — Trust Score now ${outcome.trustScore}.`
            : "Thanks! Grade confirmed.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record your verdict");
    }
  }

  async function onDispute() {
    if (!disputeReason.trim()) {
      toast.error("Tell us what didn't match.");
      return;
    }
    try {
      const outcome = await confirmPurchase(purchase.id, {
        match_status: "disputed",
        dispute_reason: disputeReason.trim(),
      });
      setDisputing(false);
      setDisputeReason("");
      toast.success(
        outcome?.guaranteeEligible
          ? "Mismatch reported — this may qualify for your Grade-Locked guarantee."
          : "Mismatch reported. Thanks for the honest signal.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record your verdict");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {purchase.brand ? `${purchase.brand} — ` : ""}
              {purchase.title ?? "Graded item"}
            </p>
            <p className="text-xs text-muted-foreground">
              {purchase.marketplace ? `${purchase.marketplace} · ` : ""}
              {purchase.purchase_price_cents != null
                ? `$${(purchase.purchase_price_cents / 100).toFixed(0)} · `
                : ""}
              {purchase.purchased_at ?? "no date"}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={`/cert/${purchase.certificate_id}`}>Grade</Link>
          </Button>
        </div>

        {/* US-1820: guarantee coverage snapshot. */}
        {purchase.coverage && (
          <div className="flex items-center gap-1.5 text-xs">
            <ShieldCheck
              className={
                purchase.coverage.eligible ? "h-3.5 w-3.5 text-emerald-600" : "h-3.5 w-3.5 text-muted-foreground"
              }
            />
            {purchase.coverage.eligible && purchase.coverage.covered_until ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                Grade-Locked — covered until{" "}
                {new Date(purchase.coverage.covered_until).toLocaleDateString()}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {purchase.coverage.ineligible_reason === "plan_not_covered"
                  ? "Guarantee not included on your plan"
                  : "Guarantee coverage unavailable"}
              </span>
            )}
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Arrival photos ({captured.size}/{ARRIVAL_TYPES.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {ARRIVAL_TYPES.map((type) => {
              const done = captured.has(type);
              return (
                <div key={type}>
                  <input
                    ref={(el) => { inputs.current[type] = el; }}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => onPick(type, e.target.files?.[0])}
                  />
                  <Button
                    type="button"
                    variant={done ? "secondary" : "outline"}
                    size="sm"
                    disabled={isUploading}
                    onClick={() => inputs.current[type]?.click()}
                    className="capitalize"
                  >
                    {done ? <Check className="mr-1 h-3.5 w-3.5" /> : <Camera className="mr-1 h-3.5 w-3.5" />}
                    {type}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        {/* US-1812: confirm the grade matched (or report a mismatch). */}
        <div className="border-t pt-3">
          {purchase.outcome ? (
            purchase.outcome.match_status === "confirmed" ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" /> You confirmed this grade matched.
              </p>
            ) : (
              <div className="space-y-1 text-xs">
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  You reported a{" "}
                  {purchase.outcome.dispute_severity === "material" ? "material" : ""} mismatch.
                </p>
                {purchase.outcome.dispute_reason && (
                  <p className="text-muted-foreground">“{purchase.outcome.dispute_reason}”</p>
                )}
                {purchase.outcome.guarantee_eligible && (
                  <p className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" /> May qualify for your Grade-Locked guarantee.
                  </p>
                )}
              </div>
            )
          ) : disputing ? (
            <div className="space-y-2">
              <Label htmlFor={`dispute-${purchase.id}`} className="text-xs">
                What didn&apos;t match the grade?
              </Label>
              <Textarea
                id={`dispute-${purchase.id}`}
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="e.g. arrived with a stain on the front and a broken zipper"
                rows={2}
                className="text-sm"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={isConfirming} onClick={onDispute}>
                  Submit mismatch
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isConfirming}
                  onClick={() => { setDisputing(false); setDisputeReason(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Did the item match its grade?</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={isConfirming} onClick={onConfirm}>
                  {isConfirming ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                  Grade matched
                </Button>
                <Button size="sm" variant="outline" disabled={isConfirming} onClick={() => setDisputing(true)}>
                  Report mismatch
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function BuyerRewardsPage() {
  const ent = useBuyerEntitlements();
  const { purchases, isLoading, linkPurchase, isLinking, rewardCredits } = useBuyerPurchases();

  const [certNumber, setCertNumber] = useState("");
  const [price, setPrice] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");

  if (!ent.has("rewards")) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <Lock className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-bold">Rewards</h1>
          <p className="text-sm text-muted-foreground">
            Link your graded purchases and confirm arrival condition to earn rewards. This is part
            of a higher buyer plan.
          </p>
          <Button asChild>
            <Link to="/buyer/billing?upgrade=rewards">See plans</Link>
          </Button>
        </Card>
      </div>
    );
  }

  async function onLink() {
    if (!certNumber.trim()) {
      toast.error("Enter the certificate number from the grade.");
      return;
    }
    try {
      await linkPurchase({
        cert_number: certNumber.trim(),
        purchase_price_cents: centsFromDollars(price),
        marketplace: marketplace.trim() || null,
        purchased_at: purchasedAt || null,
      });
      toast.success("Purchase linked — add arrival photos below.");
      setCertNumber("");
      setPrice("");
      setMarketplace("");
      setPurchasedAt("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not link the purchase.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Gift className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Rewards</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Link an item you bought to its GradeThread grade, then snap arrival photos to confirm it
        matched — and earn rewards.
      </p>

      {/* US-1813: reward-credit balance. Credits spend on authenticity / video
          grades once your monthly allowance is used up. */}
      {rewardCredits && rewardCredits.lifetime_earned > 0 && (
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2">
              <Gift className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium">{rewardCredits.balance} reward credits</p>
                <p className="text-xs text-muted-foreground">
                  {rewardCredits.lifetime_earned} earned all-time · spend on authenticity &amp; video grades
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Link a purchase</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cert">Certificate number</Label>
            <Input
              id="cert"
              placeholder="GT-XXXXXXX"
              value={certNumber}
              onChange={(e) => setCertNumber(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="price">Price paid (USD)</Label>
              <Input id="price" type="number" min={0} placeholder="Optional" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mkt">Marketplace</Label>
              <Input id="mkt" placeholder="eBay, Poshmark…" value={marketplace} onChange={(e) => setMarketplace(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="date">Purchase date</Label>
              <Input id="date" type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={onLink} disabled={isLinking}>
              {isLinking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Link purchase
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your linked purchases
        </h2>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : purchases.length === 0 ? (
          <EmptyState
            icon={Gift}
            title="No linked purchases yet"
            description="Link a graded item you bought above to start confirming arrival condition and earning rewards."
          />
        ) : (
          purchases.map((p) => <PurchaseCard key={p.id} purchase={p} />)
        )}
      </div>
    </div>
  );
}
