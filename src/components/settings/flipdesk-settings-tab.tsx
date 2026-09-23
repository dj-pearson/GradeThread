import { useState } from "react";
import { useNavigate } from "react-router";
import { Compass, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { toastError } from "@/lib/toast-error";
import { PromotedListingsDefaultCard } from "@/components/flipdesk/promoted-listings-default-card";
import { ListingDefaultsCard } from "@/components/flipdesk/listing-defaults-card";
import { useOnboardingTourStore } from "@/stores/onboarding-tour-store";
import { useActivation } from "@/hooks/use-activation";
import { MeasurementSharingCard } from "@/components/settings/measurement-sharing-card";
import { RadarContributionCard } from "@/components/settings/radar-contribution-card";

// The FlipDesk tab of /dashboard/settings: tour and checklist replays, sale-
// outcome sharing, and the listing/consent cards. Split out of settings.tsx
// (web-growth action 6).
export function FlipdeskSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  // US-2859: the FlipDesk checklist is not a separate tour any more; replaying
  // it means bringing the one activation checklist back.
  const { undismiss: undismissActivation } = useActivation();
  const openWelcomeTour = useOnboardingTourStore((s) => s.open);

  function replayFlipdeskTour() {
    undismissActivation();
    navigate("/dashboard/flipdesk");
  }

  function replayWelcomeTour() {
    openWelcomeTour();
    navigate("/dashboard");
  }

  const [shareOutcomes, setShareOutcomes] = useState(
    profile?.share_sale_outcomes ?? false
  );
  const [savingShareOutcomes, setSavingShareOutcomes] = useState(false);

  async function handleSaveShareOutcomes(next: boolean) {
    if (!user) return;
    setSavingShareOutcomes(true);
    setShareOutcomes(next);
    try {
      const { error } = await supabase
        .from("users")
        .update({ share_sale_outcomes: next } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(
        next
          ? "Thanks — your sale outcomes will help improve AI grading."
          : "Sale-outcome sharing turned off."
      );
    } catch (err) {
      // Revert the optimistic flip if the save fails.
      setShareOutcomes(!next);
      toastError(err, "Failed to update sale-outcome sharing.");
    } finally {
      setSavingShareOutcomes(false);
    }
  }

  return (
    <>
          {/* Onboarding / product tour */}
          <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Product tour
          </CardTitle>
          <CardDescription>
            Replay the welcome walkthrough any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Welcome tour</p>
              <p className="text-xs text-muted-foreground">
                Revisit the quick walkthrough and update what you use
                GradeThread for.
              </p>
            </div>
            <Button variant="outline" onClick={replayWelcomeTour}>
              Replay tour
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* FlipDesk Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-primary" />
            FlipDesk
          </CardTitle>
          <CardDescription>
            Preferences for the FlipDesk reseller workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Setup checklist</p>
              <p className="text-xs text-muted-foreground">
                Bring the setup checklist back, with whatever you have already
                done still ticked off.
              </p>
            </div>
            <Button variant="outline" onClick={replayFlipdeskTour}>
              Show it again
            </Button>
          </div>

          <Separator />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                Share sale outcomes with GradeThread
              </p>
              <p className="text-xs text-muted-foreground">
                When a graded item sells, share the sold price (no buyer
                info) so the AI grading model can learn how grades correlate
                with real resale values. Opt-in, off by default.
              </p>
            </div>
            <Switch
              checked={shareOutcomes}
              onCheckedChange={handleSaveShareOutcomes}
              disabled={savingShareOutcomes}
              aria-label="Share sale outcomes"
            />
          </div>
        </CardContent>
      </Card>

      {/* US-2852 / 00668: how a new listing opens — format, Best Offer, quantity.
          Sits above the ad-rate card because it is the shape of the listing;
          promotion is a decision you make about a listing that already exists. */}
      <ListingDefaultsCard />

      {/* 00432: Promoted Listings default (off by default, opt-in). */}
      <PromotedListingsDefaultCard />

      {/* US-1861: Thrift Radar contribution — its own consent, its own column,
          its own copy. Never fold it into the sale-outcome switch above. */}
      <RadarContributionCard />

      {/* US-3038: measurement sharing. Same rule as Radar — its own consent and
          its own column — but OPT-OUT rather than opt-in, which is why it is a
          card with the full disclosure rather than one more switch in a list. */}
      <MeasurementSharingCard />
    </>
  );
}
