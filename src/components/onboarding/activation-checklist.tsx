import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  Sparkles,
  X,
  ArrowRight,
  FileText,
  Package,
  Store,
  KeyRound,
  Bell,
  type LucideIcon,
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
import { useAuthStore } from "@/stores/auth-store";
import { useEbayConnection } from "@/hooks/use-ebay";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import type { UserUseCase } from "@/types/database";

// US-1122: the app-wide, persona-aware post-signup activation checklist —
// the web counterpart to the iOS ActivationChecklist (US-647). It generalizes
// the FlipDesk-only getting-started checklist into a checklist tailored to the
// user's onboarding `use_case`, shown on the dashboard home until the user
// completes every step or dismisses it. Each step is "done" when the real
// underlying action has happened (a grade exists, inventory exists, eBay is
// connected, browser notifications are granted) — not when a button is clicked.

type StepKey = "grade" | "inventory" | "ebay" | "apikey" | "notifications";

interface ChecklistStepDef {
  key: StepKey;
  icon: LucideIcon;
  title: string;
  desc: string;
  cta: string;
  to?: string;
}

// Whether the browser supports the Notifications API at all (excluded otherwise).
const NOTIFICATIONS_SUPPORTED =
  typeof window !== "undefined" && "Notification" in window;

function stepsFor(useCase: UserUseCase | null): ChecklistStepDef[] {
  const grade: ChecklistStepDef = {
    key: "grade",
    icon: FileText,
    title: "Grade your first garment",
    desc: "Upload photos to get an AI-powered condition grade.",
    cta: "New submission",
    to: "/dashboard/submissions/new",
  };
  const inventory: ChecklistStepDef = {
    key: "inventory",
    icon: Package,
    title: "Add an inventory item",
    desc: "Start tracking a piece of inventory end to end.",
    cta: "Add item",
    // US-2858: /dashboard/inventory/new is a Navigate to this route.
    to: "/dashboard/flipdesk/intake",
  };
  const ebay: ChecklistStepDef = {
    key: "ebay",
    icon: Store,
    title: "Connect eBay",
    desc: "Sync your listings, orders, and payouts automatically.",
    cta: "Connect",
    to: "/dashboard/flipdesk/marketplaces",
  };
  const apikey: ChecklistStepDef = {
    key: "apikey",
    icon: KeyRound,
    title: "Create an API key",
    desc: "Grade garments programmatically from your own app.",
    cta: "Create key",
    // US-2858: the Developers page, not the Account hub tab (US-2554).
    to: "/dashboard/developers",
  };
  const notifications: ChecklistStepDef = {
    key: "notifications",
    icon: Bell,
    title: "Turn on notifications",
    desc: "Get notified the moment something sells or a payout lands.",
    cta: "Enable",
  };

  const tail = NOTIFICATIONS_SUPPORTED ? [notifications] : [];

  switch (useCase) {
    case "buyer":
      // Buyers don't grade/sell; the dashboard's persona first-run card covers
      // them, so no multi-step activation checklist.
      return [];
    case "developer":
      return [apikey, grade, ...tail];
    case "consignment":
    case "seller":
    default:
      return [grade, inventory, ebay, ...tail];
  }
}

function dismissKey(userId: string | undefined): string {
  return `gt.activation-checklist.dismissed:${userId ?? "anon"}`;
}

export function ActivationChecklist() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const user = useAuthStore((s) => s.user);

  // Local, per-user dismissal (mirrors the iOS UserDefaults flag). Seeded
  // synchronously from localStorage so the card never flashes for a user who
  // already dismissed it.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(dismissKey(user?.id)) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(dismissKey(user?.id)) === "1");
  }, [user?.id]);

  // Browser notification permission ('default' | 'granted' | 'denied').
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(
    NOTIFICATIONS_SUPPORTED ? Notification.permission : "unsupported",
  );

  const useCase = profile?.use_case ?? null;
  const steps = useMemo(() => stepsFor(useCase), [useCase]);
  const stepKeys = useMemo(() => new Set(steps.map((s) => s.key)), [steps]);

  // US-1435: resellers (seller/consignment) are activated FIRST by the FlipDesk
  // onboarding checklist (source → intake → grade) on the FlipDesk surface. Keep
  // this dashboard-home checklist mutually exclusive with it by sequencing: don't
  // show it for a reseller until flipdesk_onboarded is set, so the two never run
  // as competing cards. Non-resellers (developer) have no FlipDesk checklist, so
  // they see this one immediately.
  const isReseller = useCase === "seller" || useCase === "consignment";

  // Only show once general onboarding is finished (onboarded_at set) so we don't
  // fight the first-run OnboardingFlow modal that captures the use case.
  const active =
    !!profile &&
    !!profile.onboarded_at &&
    !dismissed &&
    steps.length > 0 &&
    (!isReseller || !!profile.flipdesk_onboarded);

  const { data: counts } = useQuery({
    queryKey: ["activation-checklist-counts", user?.id],
    enabled: active && !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const needApiKeys = stepKeys.has("apikey");
      const needInventory = stepKeys.has("inventory");
      const [graded, inventory, apiKeys] = await Promise.all([
        stepKeys.has("grade")
          ? supabase.from("submissions").select("id", { count: "exact", head: true })
          : Promise.resolve({ count: 0 }),
        needInventory
          ? supabase.from("inventory_items").select("id", { count: "exact", head: true })
          : Promise.resolve({ count: 0 }),
        needApiKeys
          ? supabase.from("api_keys").select("id", { count: "exact", head: true })
          : Promise.resolve({ count: 0 }),
      ]);
      return {
        graded: graded.count ?? 0,
        inventory: inventory.count ?? 0,
        apiKeys: apiKeys.count ?? 0,
      };
    },
  });

  const { data: ebayConnection } = useEbayConnection();

  const doneByKey = useMemo<Record<StepKey, boolean>>(
    () => ({
      grade: (counts?.graded ?? 0) > 0,
      inventory: (counts?.inventory ?? 0) > 0,
      apikey: (counts?.apiKeys ?? 0) > 0,
      ebay: !!ebayConnection,
      notifications: notifPermission === "granted",
    }),
    [counts, ebayConnection, notifPermission],
  );

  const enableNotifications = useCallback(async () => {
    if (!NOTIFICATIONS_SUPPORTED) return;
    if (Notification.permission === "denied") {
      toast.error(
        "Notifications are blocked. Enable them for this site in your browser settings.",
      );
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
      if (result === "granted") {
        track("onboarding.notifications_enabled", { surface: "activation_checklist" });
        toast.success("Notifications enabled.");
      }
    } catch {
      toast.error("Couldn't enable notifications.");
    }
  }, []);

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(user?.id), "1");
    }
    setDismissed(true);
    track("onboarding.activation_checklist_dismissed", { use_case: useCase });
  }

  const doneCount = steps.filter((s) => doneByKey[s.key]).length;
  const allDone = steps.length > 0 && doneCount === steps.length;
  const activeIndex = steps.findIndex((s) => !doneByKey[s.key]);

  if (!active || allDone) return null;

  return (
    <Card className="border-brand-navy/30 bg-brand-navy/5">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy/10">
            <Sparkles className="h-5 w-5 text-brand-navy dark:text-foreground" />
          </div>
          <div>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              A few quick steps to get the most out of GradeThread ·{" "}
              {doneCount}/{steps.length} done
            </CardDescription>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label="Dismiss setup checklist"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step, i) => {
          const done = doneByKey[step.key];
          const isCurrent = i === activeIndex;
          const Icon = step.icon;
          return (
            <div
              key={step.key}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                done
                  ? "border-transparent bg-background/60"
                  : isCurrent
                    ? "border-brand-navy/40 bg-background"
                    : "border-transparent bg-background/40 opacity-70",
              )}
            >
              <div
                className={cn(
                  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                  done ? "bg-brand-navy text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    done && "text-muted-foreground line-through",
                  )}
                >
                  {step.title}
                </p>
                <p className="text-xs text-muted-foreground">{step.desc}</p>
              </div>
              {!done && (
                <Button
                  size="sm"
                  variant={isCurrent ? "default" : "outline"}
                  onClick={() => {
                    if (step.key === "notifications") void enableNotifications();
                    else if (step.to) navigate(step.to);
                  }}
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
            Each step completes on its own once you do the real thing.
          </p>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Skip for now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
