import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles,
  Tag,
  ShoppingBag,
  Store,
  Code,
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
import { supabase } from "@/lib/supabase";
import { useOnboardingTourStore } from "@/stores/onboarding-tour-store";
import type { UserUpdate, UserUseCase } from "@/types/database";

const USE_CASES: {
  value: UserUseCase;
  label: string;
  description: string;
  icon: React.ElementType;
}[] = [
  {
    value: "seller",
    label: "Reselling",
    description: "I sell pre-owned clothing and want condition grades.",
    icon: Tag,
  },
  {
    value: "buyer",
    label: "Buying",
    description: "I buy pre-owned clothing and want to verify condition.",
    icon: ShoppingBag,
  },
  {
    value: "consignment",
    label: "Consignment",
    description: "I run a consignment shop or grading service.",
    icon: Store,
  },
  {
    value: "developer",
    label: "Developer",
    description: "I want to integrate grading through the API.",
    icon: Code,
  },
];

const TOUR_STEPS: {
  icon: React.ElementType;
  title: string;
  text: string;
}[] = [
  {
    icon: FileText,
    title: "Submit garments",
    text: "Upload photos and get an AI-powered condition grade in minutes — find this under Submissions.",
  },
  {
    icon: Package,
    title: "Track inventory",
    text: "Manage items, listings, and sales end-to-end from the Inventory section.",
  },
  {
    icon: BarChart3,
    title: "Understand your finances",
    text: "Profit, ROI, and inventory aging update automatically on the Finances page.",
  },
  {
    icon: KeyRound,
    title: "Build with the API",
    text: "Generate API keys to grade garments programmatically — see the API Keys page.",
  },
];

const LAST_STEP = 1 + TOUR_STEPS.length; // welcome=0, use case=1, tour=2..5

// Where each use case should land first. Sellers go to FlipDesk, which then
// surfaces its getting-started checklist (incl. the grading bridge); the
// checklist intentionally waits for onboarded_at before showing (US-742).
function nextActionFor(useCase: UserUseCase | null): string {
  switch (useCase) {
    case "seller":
      return "/dashboard/flipdesk";
    case "developer":
      return "/dashboard/account?tab=api-keys";
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

  // First-run: show until onboarded_at is set. Replay-from-Settings: show on
  // demand even after onboarding, starting fresh from the welcome step.
  const firstRun = !!profile && !profile.onboarded_at && !dismissed;
  const shouldShow = reopened || firstRun;

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
        // Reinforce the up-front gate: no Escape / outside-click close until a
        // use case is picked.
        onEscapeKeyDown={(e) => {
          if (!useCase) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!useCase) e.preventDefault();
        }}
      >
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
              {USE_CASES.map((option) => {
                const selected = useCase === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
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

        {/* Steps 2..5 — Feature tour */}
        {isTour && TOUR_STEPS[tourIndex] && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                {(() => {
                  const Icon = TOUR_STEPS[tourIndex]!.icon;
                  return <Icon className="h-6 w-6 text-primary" />;
                })()}
              </div>
              <DialogTitle className="text-center">
                {TOUR_STEPS[tourIndex]!.title}
              </DialogTitle>
              <DialogDescription className="text-center">
                {TOUR_STEPS[tourIndex]!.text}
              </DialogDescription>
            </DialogHeader>
          </>
        )}

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5">
          {Array.from({ length: LAST_STEP + 1 }).map((_, i) => (
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
                onClick={() => setStep((s) => s - 1)}
                disabled={saving}
              >
                Back
              </Button>
            )}
            {step < LAST_STEP ? (
              <Button
                size="sm"
                onClick={() => setStep((s) => s + 1)}
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
