import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  Sparkles,
  Store,
  PackagePlus,
  Award,
  X,
  ArrowRight,
  Loader2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useSources } from "@/hooks/use-sources";
import { useAuthStore } from "@/stores/auth-store";
import { useFlipdeskTourStore } from "@/stores/flipdesk-tour-store";
import { cn } from "@/lib/utils";
import type { UserUpdate } from "@/types/database";

// The FlipDesk getting-started checklist. Each step is "done" when the real
// underlying action has been performed (a source/item/grading row exists),
// not when a popover is clicked through.
export function FlipdeskOnboarding() {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile, refreshProfile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const reopened = useFlipdeskTourStore((s) => s.reopened);
  const closeTour = useFlipdeskTourStore((s) => s.close);
  const [busy, setBusy] = useState(false);
  const completedRef = useRef(false);

  const onFlipdesk = location.pathname.startsWith("/dashboard/flipdesk");
  // Don't fight the first-run welcome modal: until general onboarding is
  // finished (onboarded_at set), the OnboardingFlow dialog owns the screen and
  // routes sellers here afterwards. A `reopened` replay from Settings bypasses
  // the gate. (US-742)
  const active =
    onFlipdesk &&
    !!profile &&
    (reopened ||
      (!!profile.onboarded_at && !profile.flipdesk_onboarded));

  const { data: sources = [] } = useSources();

  const { data: itemCount = 0 } = useQuery({
    queryKey: ["flipdesk-onboarding-items", user?.id],
    enabled: active && !!user,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from("inventory_items")
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: gradingCount = 0 } = useQuery({
    queryKey: ["flipdesk-onboarding-grading", user?.id],
    enabled: active && !!user,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from("flipdesk_grading_submissions")
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  const steps = [
    {
      icon: Store,
      title: "Add your first source",
      desc: "Where inventory comes from — a thrift store, estate sale, or auction lot.",
      done: sources.length > 0,
      cta: "Add a source",
      to: "/dashboard/flipdesk/sourcing?tab=sources",
    },
    {
      icon: PackagePlus,
      title: "Add your first item",
      desc: "Catalog your first piece of inventory with the quick intake form.",
      done: itemCount > 0,
      cta: "Add item",
      to: "/dashboard/flipdesk/intake",
    },
    {
      icon: Award,
      title: "Send it to GradeThread",
      desc: "Get an AI condition grade to back up the listing and command a higher price.",
      done: gradingCount > 0,
      cta: "Open my items",
      // US-2858: /dashboard/flipdesk/items is an InventoryModeRedirect.
      to: "/dashboard/flipdesk/inventory",
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  const activeIndex = steps.findIndex((s) => !s.done);

  async function markOnboarded(showToast: boolean) {
    if (!user) return;
    setBusy(true);
    try {
      const update: UserUpdate = { flipdesk_onboarded: true };
      const { error } = await supabase
        .from("users")
        .update(update as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      if (showToast) toast.success("You're all set up on FlipDesk.");
    } catch {
      toast.error("Couldn't save onboarding progress.");
    } finally {
      setBusy(false);
      closeTour();
    }
  }

  // Auto-complete once all three real actions are done.
  useEffect(() => {
    if (
      !active ||
      !profile ||
      profile.flipdesk_onboarded ||
      !allDone ||
      completedRef.current
    ) {
      return;
    }
    completedRef.current = true;
    void markOnboarded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allDone, profile]);

  if (!active) return null;

  // When re-opened from Settings after completion, closing just hides it.
  function handleClose() {
    if (profile?.flipdesk_onboarded) {
      closeTour();
    } else {
      void markOnboarded(false);
    }
  }

  return (
    <Card className="mb-6 border-brand-navy/30 bg-brand-navy/5">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy/10">
            <Sparkles className="h-5 w-5 text-brand-navy dark:text-foreground" />
          </div>
          <div>
            <CardTitle>Welcome to FlipDesk</CardTitle>
            <CardDescription>
              Three quick steps to run your first item end to end ·{" "}
              {doneCount}/{steps.length} done
            </CardDescription>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          disabled={busy}
          aria-label="Dismiss onboarding"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <X className="h-4 w-4" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step, i) => {
          const isCurrent = i === activeIndex;
          return (
            <div
              key={step.title}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                step.done
                  ? "border-transparent bg-background/60"
                  : isCurrent
                    ? "border-brand-navy/40 bg-background"
                    : "border-transparent bg-background/40 opacity-70",
              )}
            >
              <div
                className={cn(
                  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                  step.done
                    ? "bg-brand-navy text-white"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {step.done ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <step.icon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.done && "text-muted-foreground line-through",
                  )}
                >
                  {step.title}
                </p>
                <p className="text-xs text-muted-foreground">{step.desc}</p>
              </div>
              {!step.done && (
                <Button
                  size="sm"
                  variant={isCurrent ? "default" : "outline"}
                  onClick={() => navigate(step.to)}
                  className="flex-shrink-0"
                >
                  {step.cta}
                  <ArrowRight className="ml-1.5 h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {allDone
              ? "All done — nice work!"
              : "Each step completes on its own once you do the real thing."}
          </p>
          {!profile?.flipdesk_onboarded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markOnboarded(false)}
              disabled={busy}
            >
              Skip for now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
