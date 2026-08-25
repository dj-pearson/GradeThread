import { useRef, useState } from "react";
import { Link } from "react-router";
import { Camera, Check, Flame, Gift, Loader2, Plus, Share2, ShieldCheck, Snowflake, Trophy } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BuyerPlaceholderPage } from "@/pages/buyer/placeholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerPurchases, type PurchaseWithCaptures } from "@/hooks/use-buyer-purchases";
import { useBuyerRewards } from "@/hooks/use-buyer-rewards";
import { useNudgeAttribution } from "@/hooks/use-nudge-attribution";
import { trackBuyerFeature } from "@/lib/buyer-analytics";
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

// US-1821: buyer-facing guarantee claim status copy.
function claimStatusLabel(status: string): string {
  switch (status) {
    case "auto_approved":
    case "approved":
      return "Guarantee claim approved";
    case "paid":
      return "Guarantee claim paid";
    case "manual_review":
      return "Guarantee claim under review";
    case "rejected":
      return "Guarantee claim not covered";
    default:
      return "Guarantee claim filed";
  }
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
  const { uploadArrival, isUploading, confirmPurchase, isConfirming, fileClaim, isFilingClaim } =
    useBuyerPurchases();
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
      toastError(e, "Upload failed");
    }
  }

  async function onConfirm() {
    try {
      const outcome = await confirmPurchase(purchase.id, { match_status: "confirmed" });
      trackBuyerFeature("confirmations", "confirmed");
      const credits = outcome?.rewardCreditsIssued ?? 0;
      toast.success(
        credits > 0
          ? `Thanks! Grade confirmed — you earned ${credits} reward credit${credits === 1 ? "" : "s"}.`
          : outcome?.trustScore != null
            ? `Thanks! Grade confirmed — Trust Score now ${outcome.trustScore}.`
            : "Thanks! Grade confirmed.",
      );
    } catch (e) {
      toastError(e, "Could not record your verdict");
    }
  }

  async function onClaim() {
    // US-1845: the ATTEMPT, from the browser and carrying acquisition source.
    // The edge records the decision separately (buyer-guarantee-claim.ts) — a
    // filed claim and an approved claim are different numbers and the funnel
    // needs both, not one standing in for the other.
    trackBuyerFeature("guarantee_claims", "filed");
    try {
      const claim = await fileClaim(purchase.id);
      toast.success(
        claim?.status === "auto_approved"
          ? `Claim approved — $${((claim.remedyCents ?? 0) / 100).toFixed(2)} covered (${claim.remedyCredits} credits).`
          : "Claim filed — our team is reviewing it.",
      );
    } catch (e) {
      toastError(e, "Could not file the claim");
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
      trackBuyerFeature("confirmations", "disputed", {
        guarantee_eligible: outcome?.guaranteeEligible === true,
      });
      setDisputing(false);
      setDisputeReason("");
      toast.success(
        outcome?.guaranteeEligible
          ? "Mismatch reported — this may qualify for your Grade-Locked guarantee."
          : "Mismatch reported. Thanks for the honest signal.",
      );
    } catch (e) {
      toastError(e, "Could not record your verdict");
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
                  <div className="space-y-1">
                    <p className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                      <ShieldCheck className="h-3.5 w-3.5" /> May qualify for your Grade-Locked guarantee.
                    </p>
                    {purchase.claim ? (
                      <p className="text-muted-foreground">
                        {claimStatusLabel(purchase.claim.status)}
                        {purchase.claim.remedy_cents > 0
                          ? ` — $${(purchase.claim.remedy_cents / 100).toFixed(2)} covered`
                          : ""}
                      </p>
                    ) : (
                      <Button size="sm" variant="outline" disabled={isFilingClaim} onClick={onClaim}>
                        {isFilingClaim ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : (
                          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                        )}
                        File guarantee claim
                      </Button>
                    )}
                  </div>
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

// US-1814: streak + lifetime impact, a shareable receipt, and the opt-in
// confirmer leaderboard.
function RewardsSummarySection() {
  const { summary, leaderboard, myLeaderboard, setLeaderboardOptIn, isUpdatingOptIn } = useBuyerRewards();
  const [nameDraft, setNameDraft] = useState("");

  // Nothing to celebrate until the buyer has confirmed at least one grade.
  if (!summary || (summary.lifetimeConfirmations === 0 && summary.caughtOverGraded === 0)) return null;

  async function onShare() {
    if (!summary) return;
    const text =
      `I've confirmed ${summary.lifetimeConfirmations} grade${summary.lifetimeConfirmations === 1 ? "" : "s"} ` +
      `and caught ${summary.caughtOverGraded} over-graded listing${summary.caughtOverGraded === 1 ? "" : "s"} ` +
      `on GradeThread — verifying condition, keeping good pieces in circulation. #GradeThread`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "My GradeThread rewards", text });
      } else {
        await navigator.clipboard.writeText(text);
        toast.success("Receipt copied — paste it anywhere.");
      }
    } catch {
      /* user cancelled the share sheet — no-op */
    }
  }

  const enabled = myLeaderboard?.enabled ?? false;
  const displayName = myLeaderboard?.display_name ?? "";

  async function onToggleLeaderboard() {
    try {
      if (enabled) {
        await setLeaderboardOptIn({ enabled: false });
        toast.success("Left the leaderboard.");
      } else {
        const name = (nameDraft || displayName).trim();
        if (!name) {
          toast.error("Add a display name to join the leaderboard.");
          return;
        }
        await setLeaderboardOptIn({ enabled: true, display_name: name });
        toast.success("You're on the confirmer leaderboard.");
      }
    } catch (e) {
      toastError(e, "Couldn't update the leaderboard.");
    }
  }

  return (
    <>
      {/* Impact receipt (shareable). */}
      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="flex items-center justify-center gap-1 text-2xl font-bold">
                <Flame className="h-5 w-5 text-brand-red-text" />
                {summary.currentStreakWeeks}
              </p>
              <p className="text-xs text-muted-foreground">week streak</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{summary.lifetimeConfirmations}</p>
              <p className="text-xs text-muted-foreground">grades confirmed</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{summary.caughtOverGraded}</p>
              <p className="text-xs text-muted-foreground">over-grades caught</p>
            </div>
          </div>
          {/* US-1851 AC3: the streak lives HERE, on the one surface with a
              genuinely weekly rhythm — and it comes with grace + freeze rules so
              one quiet week can't erase months of honest confirmations. */}
          {(summary.inGraceWeek || summary.freezesBanked > 0 || summary.freezesUsed > 0) && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs">
              <Snowflake className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sky-600" />
              <p className="text-muted-foreground">
                {summary.inGraceWeek && "Your streak is safe through Sunday. "}
                {summary.freezesUsed > 0 &&
                  `${summary.freezesUsed} freeze${summary.freezesUsed === 1 ? "" : "s"} kept it alive through a quiet week. `}
                {summary.freezesBanked > 0
                  ? `${summary.freezesBanked} streak freeze${summary.freezesBanked === 1 ? "" : "s"} banked — you earn one every 4 weeks.`
                  : "Confirm 4 weeks running to bank a streak freeze."}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {summary.lifetimeConfirmations} item{summary.lifetimeConfirmations === 1 ? "" : "s"} verified in
              circulation · best streak {summary.longestStreakWeeks}w
            </p>
            <Button size="sm" variant="outline" onClick={onShare}>
              <Share2 className="mr-1 h-3.5 w-3.5" /> Share
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Opt-in confirmer leaderboard. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="h-5 w-5 text-primary" /> Confirmer leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {enabled ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                You&apos;re on the board as <span className="font-medium text-foreground">{displayName}</span>.
              </span>
              <Button size="sm" variant="ghost" disabled={isUpdatingOptIn} onClick={onToggleLeaderboard}>
                Leave
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="lb-name" className="text-xs">Public display name (alias only)</Label>
                <Input
                  id="lb-name"
                  placeholder="e.g. ThriftScout"
                  value={nameDraft || displayName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={40}
                />
              </div>
              <Button size="sm" disabled={isUpdatingOptIn} onClick={onToggleLeaderboard}>
                {isUpdatingOptIn ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Join
              </Button>
            </div>
          )}

          {leaderboard.length > 0 ? (
            <ol className="space-y-1 text-sm">
              {leaderboard.slice(0, 10).map((row, i) => (
                <li key={`${row.display_name}-${i}`} className="flex items-center justify-between">
                  <span className="truncate">
                    <span className="mr-2 tabular-nums text-muted-foreground">{i + 1}.</span>
                    {row.display_name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{row.confirmations}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              No confirmers on the board yet — join and be the first.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export function BuyerRewardsPage() {
  // US-1859: the streak-at-risk nudge deep-links here with ?nudge=<sendId>.
  useNudgeAttribution();
  const ent = useBuyerEntitlements();
  const { purchases, isLoading, isError, isFetching, refetch, linkPurchase, isLinking, rewardCredits } = useBuyerPurchases();

  const [certNumber, setCertNumber] = useState("");
  const [price, setPrice] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");

  if (!ent.has("rewards")) {
    // US-2509: the shared locked state. This page used to hand-roll its
    // own card; five of them had drifted into three different button
    // treatments for the same "See plans" action.
    return (
      <BuyerPlaceholderPage
        title="Rewards"
        requiresFlag="rewards"
        description="Link your graded purchases and confirm arrival condition to earn rewards."
      />
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
      toastError(e, "Could not link the purchase.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Rewards"
        subtitle="Link an item you bought to its GradeThread grade, then snap arrival photos to confirm it matched — and earn rewards."
        icon={Gift}
      />

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

      <RewardsSummarySection />

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
        <h2 className="text-base font-semibold text-foreground">
          Your linked purchases
        </h2>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : isError ? (
          /* US-2026: a failed load must not render as an empty state — that reads as data loss, not as "retry". */
          /* Sharpest case in this story: telling a buyer they have no linked
             purchases implies their rewards were never recorded. */
          <ErrorState
            title="Couldn't load your purchases"
            description="Your linked purchases and rewards are safe — we just couldn't fetch them right now."
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
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
