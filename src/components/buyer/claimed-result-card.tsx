import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bell, Bookmark, Loader2, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trackBuyerFeature, trackBuyerFunnel } from "@/lib/buyer-analytics";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useSavedSearches } from "@/hooks/use-saved-searches";
import { useBuyerCloset } from "@/hooks/use-buyer-closet";
import { alertCapState, countActiveSearches } from "@/lib/watchlist";
import {
  claimSummary,
  clearBuyerClaim,
  closetDraftFromClaim,
  formatClaimCents,
  readBuyerClaim,
  searchDraftFromClaim,
  type BuyerConversionClaim,
} from "@/lib/buyer-conversion-claim";

// US-1843: the account side of the free-tool handoff.
//
// A visitor priced an item on /whats-it-worth or /tools/grade-checker, pressed a
// buyer conversion moment, and signed up. The result they were looking at is
// parked in localStorage; this is where it becomes something real in their
// account — a condition alert, a closet entry, or a verification — instead of
// evaporating at the signup boundary.
//
// All three actions stay offered no matter which moment they pressed. The
// pressed one is just the primary button: a visitor who clicked "save" and then
// decided they'd rather have the alert should not have to retype the item.

export function ClaimedResultCard() {
  // Read once on mount. The claim is a snapshot; re-reading on every render
  // would fight the local `claim` state that the actions clear.
  const [claim, setClaim] = useState<BuyerConversionClaim | null>(() => readBuyerClaim());
  if (!claim) return null;
  return <ClaimedResult claim={claim} onDone={() => setClaim(null)} />;
}

function ClaimedResult({
  claim,
  onDone,
}: {
  claim: BuyerConversionClaim;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const ent = useBuyerEntitlements();
  const searches = useSavedSearches();
  const closet = useBuyerCloset();
  const [busy, setBusy] = useState<"alert" | "save" | null>(null);

  const draft = searchDraftFromClaim(claim);
  const cap = alertCapState(countActiveSearches(searches.searches), ent.config.activeAlertsCap);
  const canAlert = ent.has("conditionAlerts");
  const canSave = ent.has("wardrobePortfolio");

  function finish(action: "alert" | "save" | "verify") {
    // Closes the funnel: the same `ref` the anonymous result carried, so an
    // earned-link conversion is attributable from the free tool through signup
    // to the thing the buyer actually got (US-603 still does the redeem itself,
    // once, at sign-in — this never touches the stored ref).
    trackBuyerFunnel("claimed", {
      tool: claim.tool,
      intent: claim.intent,
      action,
      ref: claim.ref ?? undefined,
    });
  }

  async function createAlert() {
    if (cap.atCap) {
      toast.error(`Your plan runs ${cap.cap} active alerts. Pause one, or upgrade for more.`);
      return;
    }
    setBusy("alert");
    try {
      await searches.create(draft.label, {
        brands: draft.brands,
        categories: draft.categories,
        keywords: draft.keywords,
        min_grade: draft.min_grade,
        max_price_cents: draft.max_price_cents,
      });
      finish("alert");
      trackBuyerFeature("alerts", "created", { from: "claim" });
      clearBuyerClaim();
      onDone();
      toast.success("Alert created — we'll watch for it.");
      navigate("/buyer/alerts");
    } catch {
      toast.error("We couldn't create that alert. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function saveToCloset() {
    setBusy("save");
    try {
      await closet.addItem(closetDraftFromClaim(claim));
      finish("save");
      trackBuyerFeature("portfolio", "item_added", { from: "claim" });
      clearBuyerClaim();
      onDone();
      toast.success("Saved to your closet.");
      navigate("/buyer/portfolio");
    } catch (err) {
      toastError(err, "We couldn't save that item.");
    } finally {
      setBusy(null);
    }
  }

  function dismiss() {
    trackBuyerFunnel("claim_dismissed", { tool: claim.tool, intent: claim.intent });
    clearBuyerClaim();
    onDone();
  }

  const priceLine =
    draft.max_price_cents != null
      ? `at or under ${formatClaimCents(draft.max_price_cents, claim.result.currency)}`
      : null;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Pick up where you left off</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            You looked this up before you signed up — it's still here.
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Dismiss saved estimate" onClick={dismiss}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="rounded-lg border bg-muted/30 p-3 text-sm">
        <span className="font-medium">{claimSummary(claim)}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {claim.tool === "whats_it_worth"
            ? "From the free What's It Worth estimate."
            : "From your free grade check."}{" "}
          An estimate from recent sold comparables, not a guaranteed price.
        </span>
      </p>

      <div className="flex flex-wrap gap-2">
        {canAlert ? (
          <Button
            size="sm"
            variant={claim.intent === "alert" ? "default" : "outline"}
            onClick={createAlert}
            disabled={busy !== null || searches.isLoading}
          >
            {busy === "alert" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Bell className="mr-1.5 h-4 w-4" />
            )}
            Alert me when one appears
          </Button>
        ) : (
          <Button size="sm" variant="outline" asChild>
            <Link to="/buyer/billing?upgrade=conditionAlerts">
              <Bell className="mr-1.5 h-4 w-4" />
              Unlock condition alerts
            </Link>
          </Button>
        )}

        {canSave ? (
          <Button
            size="sm"
            variant={claim.intent === "save" ? "default" : "outline"}
            onClick={saveToCloset}
            disabled={busy !== null}
          >
            {busy === "save" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Bookmark className="mr-1.5 h-4 w-4" />
            )}
            Save to my closet
          </Button>
        ) : (
          <Button size="sm" variant="outline" asChild>
            <Link to="/buyer/billing?upgrade=wardrobePortfolio">
              <Bookmark className="mr-1.5 h-4 w-4" />
              Unlock your closet
            </Link>
          </Button>
        )}

        <Button
          size="sm"
          variant={claim.intent === "verify" ? "default" : "outline"}
          asChild
          onClick={() => finish("verify")}
        >
          {/* Deliberately does NOT clear the claim: verifying a certificate is a
              different item, so consuming the estimate here would lose it. */}
          <Link to="/verify">
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Verify a purchase
          </Link>
        </Button>
      </div>

      {canAlert && (
        <p className="text-xs text-muted-foreground">
          The alert watches for{" "}
          <span className="font-medium text-foreground">{draft.label}</span>
          {draft.min_grade != null ? ` at grade ${draft.min_grade.toFixed(1)} or better` : ""}
          {priceLine ? `, ${priceLine}` : ""}. You can change any of it afterwards.
          {cap.atCap && !cap.unlimited
            ? ` You're using all ${cap.cap} of your plan's active alerts — pause one first.`
            : ""}
        </p>
      )}
    </Card>
  );
}
