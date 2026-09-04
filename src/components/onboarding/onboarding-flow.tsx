import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  Sparkles,
  FileText,
  Package,
  BarChart3,
  KeyRound,
  Check,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
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
import { useAuth } from "@/hooks/use-auth";
import { AppDownloadRow } from "@/components/get-the-apps";
import { supabase } from "@/lib/supabase";
import { track } from "@/lib/analytics";
import { trackActivation } from "@/lib/activation-analytics";
import { useOnboardingTourStore } from "@/stores/onboarding-tour-store";
import { USE_CASE_OPTIONS } from "@/lib/use-cases";
import type { UserUpdate, UserUseCase } from "@/types/database";

// US-2857. These four slides used to name three rooms that had been renamed:
// "the Inventory section" (moved under FlipDesk by US-740), "the Finances page"
// (folded into FlipDesk > Money by US-2161) and "the API Keys page" (became
// Developers in US-2554). So the first thing a new account was told was a set
// of directions to places that no longer answer to those names.
//
// Two rules keep that from happening again. `navLabel` is the sidebar label,
// spelled exactly as sidebar.tsx spells it, and `to` is the canonical route,
// not one of the redirect aliases. src/test/onboarding-copy-routes.test.ts
// checks both against the real files, so the next rename breaks the build.
interface TourStep {
  icon: React.ElementType;
  title: string;
  /** Where the sidebar says to look. Must match a NavItem label exactly. */
  navLabel: string;
  /** Sidebar section, for the "Grading > Submissions" breadcrumb line. */
  navGroup: string;
  text: string;
  /** Canonical route. Never a redirect alias. */
  to: string;
}

// The three places every account uses, in the order a garment moves through
// them. Named for the destination, because the point of the slide is to make
// the nav entry recognisable when the user next looks at it.
const BASE_TOUR_STEPS: TourStep[] = [
  {
    icon: FileText,
    title: "Submissions",
    navLabel: "Submissions",
    navGroup: "Grading",
    text: "Upload photos of a garment and get a condition grade in minutes. Every grade you have ever run lives here.",
    to: "/dashboard/submissions",
  },
  {
    icon: Package,
    title: "Inventory",
    navLabel: "Inventory",
    navGroup: "FlipDesk",
    text: "Every item you own, from the day you buy it to the day it ships. Switch between a table, a grid and a board without leaving the page.",
    to: "/dashboard/flipdesk/inventory",
  },
  {
    icon: BarChart3,
    title: "Money",
    navLabel: "Money",
    navGroup: "FlipDesk",
    text: "What sold, what it cost you, what is still owed, and what your real profit was. Expenses and payout matching are tabs on this one page.",
    to: "/dashboard/flipdesk/money",
  },
];

// US-2857: the API slide is for the persona that came for the API. A seller
// does not need to be taught about API keys in their first minute.
const DEVELOPER_TOUR_STEP: TourStep = {
  icon: KeyRound,
  title: "Developers",
  navLabel: "Developers",
  navGroup: "",
  text: "Create an API key and grade garments straight from your own app. The sandbox is free, so you can build before you buy credits.",
  to: "/dashboard/developers",
};

function tourStepsFor(useCase: UserUseCase | null): TourStep[] {
  return useCase === "developer"
    ? [...BASE_TOUR_STEPS, DEVELOPER_TOUR_STEP]
    : BASE_TOUR_STEPS;
}

// Where each use case should land first. Sellers go to FlipDesk, which then
// surfaces its getting-started checklist (incl. the grading bridge); the
// checklist intentionally waits for onboarded_at before showing (US-742).
function nextActionFor(useCase: UserUseCase | null): string {
  switch (useCase) {
    case "seller":
      return "/dashboard/flipdesk";
    case "developer":
      // US-2858: /dashboard/developers is the findable API surface (US-2554).
      // /dashboard/account?tab=api-keys still resolves, but it is the hub tab,
      // not the page the sidebar points at.
      return "/dashboard/developers";
    case "buyer":
    case "consignment":
      return "/dashboard/submissions/new";
    default:
      return "/dashboard";
  }
}

function nextActionLabel(useCase: UserUseCase | null): string {
  switch (useCase) {
    case "seller":
      return "Go to FlipDesk";
    case "developer":
      return "Get API keys";
    case "buyer":
    case "consignment":
      return "Start grading";
    default:
      return "Get started";
  }
}

export function OnboardingFlow() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const reopened = useOnboardingTourStore((s) => s.reopened);
  const closeTour = useOnboardingTourStore((s) => s.close);
  const [step, setStep] = useState(0);
  // Seed the use-case selection from the saved profile so a Settings replay
  // shows the prior choice (and the essential-capture gate doesn't re-trip).
  const [useCase, setUseCase] = useState<UserUseCase | null>(
    profile?.use_case ?? null
  );
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // US-2857: the slide list depends on the persona, so the step count is not a
  // module constant any more.
  const tourSteps = tourStepsFor(useCase);
  const lastStep = 1 + tourSteps.length; // welcome=0, use case=1, tour=2..n

  // First-run: show until onboarded_at is set. Replay-from-Settings: show on
  // demand even after onboarding, starting fresh from the welcome step.
  const firstRun = !!profile && !profile.onboarded_at && !dismissed;
  const shouldShow = reopened || firstRun;

  // US-1463: the use case is often already captured on the signup form (stamped
  // via handle_new_user), so on first-run we skip the redundant use-case step
  // (step 1) and go straight to the tour. The Settings replay path (reopened)
  // still shows it so the choice remains editable there. finish() records
  // onboarded_at either way, so the first-run gate still clears.
  const skipUseCase = !reopened && !!profile?.use_case;

  // When reopened from Settings, restart at the welcome step and reflect the
  // saved use case.
  useEffect(() => {
    if (reopened) {
      setStep(0);
      setUseCase(profile?.use_case ?? null);
    }
  }, [reopened, profile?.use_case]);

  // `routeNext` is true only when the user finishes the tour (not Skip), so we
  // drop them on the first action that fits their use case.
  async function finish(routeNext = false) {
    if (!user) return;
    setSaving(true);
    try {
      const update: UserUpdate = {
        onboarded_at: new Date().toISOString(),
      };
      if (useCase) update.use_case = useCase;
      const { error } = await supabase
        .from("users")
        .update(update as never)
        .eq("id", user.id);
      if (error) throw error;
      // US-2884: the tour's two endings, and the persona choice.
      //
      // NEITHER WAS RECORDED. `onboarding.use_case_selected` fires from
      // signup.tsx and nowhere else, so a user who skipped the question at
      // signup and answered it HERE emitted nothing at all -- and the funnel
      // could not tell "skipped the tour" from "never reached it".
      //
      // `routeNext` is the signal: true only on Finish, false on Skip.
      track(routeNext ? "onboarding.tour_finished" : "onboarding.tour_skipped", {
        use_case: useCase,
      });
      trackActivation(routeNext ? "tour_finished" : "tour_skipped", user.id, {
        persona: useCase,
        platform: "web",
      });
      if (useCase) {
        track("onboarding.use_case_selected", { use_case: useCase, at: "tour" });
        trackActivation("persona_chosen", user.id, {
          persona: useCase,
          platform: "web",
        });
      }
      setDismissed(true);
      closeTour();
      await refreshProfile();
      if (routeNext) navigate(nextActionFor(useCase));
    } catch {
      // Don't trap the user — close anyway; it may reappear next session.
      setDismissed(true);
      closeTour();
      toast.error(
        "Couldn't save onboarding. You can set your use case later in Settings."
      );
    } finally {
      setSaving(false);
    }
  }

  if (!shouldShow) return null;

  const tourIndex = step - 2;
  const isTour = step >= 2;
  const tourStep = tourSteps[tourIndex];

  // US-1461 (AC3): a polite live-region announcement so screen-reader users
  // track tour progress as the step changes.
  const stepTitle =
    step === 0
      ? "Welcome to GradeThread"
      : step === 1
        ? "What brings you here?"
        : (tourSteps[tourIndex]?.title ?? "");
  const stepAnnouncement = `Step ${step + 1} of ${lastStep + 1}: ${stepTitle}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || saving) return;
        // The use case is essential and captured up front: until it's chosen
        // the dialog is non-dismissible (no outside-click / Escape close).
        // Once chosen, dismissing finishes the still-skippable tour.
        if (!useCase) return;
        void finish();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // US-1461 (AC1): the up-front use-case gate makes the corner close a dead
        // control (onOpenChange no-ops until a use case is picked), so hide it
        // until then rather than show a visible button that does nothing. Once a
        // use case is chosen the close button appears and dismisses the
        // still-skippable tour.
        showCloseButton={!!useCase}
        // Reinforce the up-front gate: no Escape / outside-click close until a
        // use case is picked.
        onEscapeKeyDown={(e) => {
          if (!useCase) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!useCase) e.preventDefault();
        }}
      >
        {/* US-1461 (AC3): announce step changes to assistive tech. */}
        <div role="status" aria-live="polite" className="sr-only">
          {stepAnnouncement}
        </div>

        {/* Step 0 — Welcome */}
        {step === 0 && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <DialogTitle className="text-center">
                Welcome to GradeThread
                {profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}
              </DialogTitle>
              <DialogDescription className="text-center">
                Let's set things up — this takes about 30 seconds.
              </DialogDescription>
            </DialogHeader>
            {/* US-3110: the apps, on the first screen of the first session.
                Deliberately NOT a tour step of its own — every tour step points
                at a sidebar entry and offers "Take me there", and
                src/test/onboarding-copy-routes.test.ts checks each one against
                the real sidebar. An App Store link has no sidebar entry, so it
                belongs on the welcome screen, where it costs nobody a click. */}
            <div className="flex flex-col items-center gap-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                Also available on your phone and in your browser
              </p>
              <AppDownloadRow surface="onboarding-welcome" className="flex flex-wrap justify-center gap-2" />
            </div>
          </>
        )}

        {/* Step 1 — Use case */}
        {step === 1 && (
          <>
            <DialogHeader>
              <DialogTitle>What brings you here?</DialogTitle>
              <DialogDescription>
                We'll tailor your dashboard to how you use GradeThread.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-2">
              {USE_CASE_OPTIONS.map((option) => {
                const selected = useCase === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    // US-1461 (AC2): expose the selected state to assistive tech,
                    // matching the signup form's use-case buttons.
                    aria-pressed={selected}
                    onClick={() => setUseCase(option.value)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg border-2 p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40"
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <option.icon className="h-5 w-5 text-primary" />
                      {selected && (
                        <Check className="h-4 w-4 text-primary" />
                      )}
                    </div>
                    <span className="text-sm font-medium">
                      {option.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Steps 2..n — a short tour of the places the user will actually use */}
        {isTour && tourStep && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                {(() => {
                  const Icon = tourStep.icon;
                  return <Icon className="h-6 w-6 text-primary" />;
                })()}
              </div>
              <DialogTitle className="text-center">
                {tourStep.title}
              </DialogTitle>
              {/* US-2857: say where it is in the sidebar, using the sidebar's
                  own words, so the slide is findable again afterwards. */}
              <p className="text-center text-xs font-medium text-muted-foreground">
                {tourStep.navGroup
                  ? `In the sidebar: ${tourStep.navGroup} > ${tourStep.navLabel}`
                  : `In the sidebar: ${tourStep.navLabel}`}
              </p>
              <DialogDescription className="text-center">
                {tourStep.text}
              </DialogDescription>
            </DialogHeader>
            {/* US-2857: every slide can be acted on, not only read. Finishing
                first means the tour does not reappear next session. */}
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={async () => {
                  await finish();
                  navigate(tourStep.to);
                }}
              >
                Take me there
              </Button>
            </div>
          </>
        )}

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5">
          {Array.from({ length: lastStep + 1 }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full transition-colors",
                i === step ? "bg-primary" : "bg-muted"
              )}
            />
          ))}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {/* Skip only appears once a use case is chosen — the tour is
              skippable, but the use-case capture before it is not. */}
          {useCase ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void finish()}
              disabled={saving}
            >
              Skip tour
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                // US-1463: hop over the skipped use-case step on the way back too.
                onClick={() =>
                  setStep((s) => (s === 2 && skipUseCase ? 0 : s - 1))
                }
                disabled={saving}
              >
                Back
              </Button>
            )}
            {step < lastStep ? (
              <Button
                size="sm"
                // US-1463: from welcome, skip the use-case step when it's already
                // been captured (first-run only).
                onClick={() =>
                  setStep((s) => (s === 0 && skipUseCase ? 2 : s + 1))
                }
                disabled={step === 1 && !useCase}
              >
                {step === 1 && !useCase ? "Pick one to continue" : "Next"}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void finish(true)}
                disabled={saving}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {nextActionLabel(useCase)}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
