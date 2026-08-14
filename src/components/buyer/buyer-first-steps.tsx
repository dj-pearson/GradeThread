import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, Check, Chrome, Shirt, Sparkles, X, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  extensionWebStoreUrl,
  isExtensionInstalled,
} from "@/lib/lister-extension";

// US-2553: the buyer's get-started steps, which now complete.
//
// They were a static array. A buyer with five live alerts was still told to
// "Create an alert", and the cards never went away — so the home page permanently
// insisted the buyer had done nothing. The seller side has had a self-hiding
// ActivationChecklist since US-1122; this is the buyer counterpart, and it
// follows the same rule that matters: a step is done when the underlying THING
// has happened, never when a button was clicked.
//
// One step changed on the way. "Verify a certificate" cannot complete: /verify
// is a public marketing page that records nothing against an account, so the
// card would have stayed lit forever — the exact defect being fixed. The closet
// is the same journey with a real signal (you verify a certificate, then save
// it), and verifying is still one click from the activity section.

type StepKey = "extension" | "alert" | "closet";

interface StepDef {
  key: StepKey;
  icon: LucideIcon;
  title: string;
  body: string;
  cta: string;
  /** Internal route, or an absolute URL for the Web Store. */
  to: string;
  external?: boolean;
}

function dismissKey(userId: string | undefined): string {
  return `gt.buyer-first-steps.dismissed:${userId ?? "anon"}`;
}

export function BuyerFirstSteps() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(dismissKey(user?.id)) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(dismissKey(user?.id)) === "1");
  }, [user?.id]);

  // The extension marker is dropped by a content script, which may land after
  // first paint — so this is state, re-read on mount, not a render-time call.
  const [hasExtension, setHasExtension] = useState(false);
  useEffect(() => {
    setHasExtension(isExtensionInstalled());
    const t = setTimeout(() => setHasExtension(isExtensionInstalled()), 1500);
    return () => clearTimeout(t);
  }, []);

  const { data: counts } = useQuery({
    queryKey: ["buyer-first-steps-counts", user?.id],
    enabled: !!user && !dismissed,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // Counts only — head:true sends no rows. Both tables are owner-scoped by
      // RLS, so this cannot see anyone else's.
      const [alerts, closet] = await Promise.all([
        supabase.from("saved_searches").select("id", { count: "exact", head: true }),
        supabase.from("closet_items").select("id", { count: "exact", head: true }),
      ]);
      return { alerts: alerts.count ?? 0, closet: closet.count ?? 0 };
    },
  });

  const storeUrl = extensionWebStoreUrl();
  const steps: StepDef[] = [
    {
      key: "extension",
      icon: Chrome,
      title: "Get a second opinion",
      body: "Install the GradeThread extension to see an objective condition read on any listing you're eyeing.",
      cta: "Get the extension",
      // US-2553 AC4: this used to point at /buyer/settings, which is not where
      // anyone gets an extension. Falls back only when no id is configured.
      to: storeUrl ?? "/buyer/settings",
      external: !!storeUrl,
    },
    {
      key: "alert",
      icon: Bell,
      title: "Set a condition alert",
      body: "Snipe on grade, not just price — get notified when a graded item in your size and brands lists.",
      cta: "Create an alert",
      to: "/buyer/alerts",
    },
    {
      key: "closet",
      icon: Shirt,
      title: "Save a graded item",
      body: "Verify a certificate and keep it in your closet, so its grade and value travel with the garment.",
      cta: "Verify and save",
      to: "/verify",
    },
  ];

  const done: Record<StepKey, boolean> = {
    extension: hasExtension,
    alert: (counts?.alerts ?? 0) > 0,
    closet: (counts?.closet ?? 0) > 0,
  };
  const doneCount = steps.filter((s) => done[s.key]).length;

  // Gone once every step is done — no "all set!" card that then needs its own
  // dismissal — and gone if the buyer says so.
  if (dismissed || doneCount === steps.length) return null;

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey(user?.id), "1");
    }
    setDismissed(true);
  }

  return (
    <section className="space-y-3">
      <Card className="border-brand-navy/30 bg-brand-navy/5">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy/10">
              <Sparkles className="h-5 w-5 text-brand-navy dark:text-foreground" />
            </div>
            <div>
              <CardTitle className="text-base">Get started</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {doneCount} of {steps.length} done
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={dismiss}
            aria-label="Dismiss get-started steps"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {steps.map((step) => {
            const Icon = step.icon;
            const isDone = done[step.key];
            return (
              <div
                key={step.key}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border bg-card p-4",
                  isDone && "opacity-60",
                )}
              >
                <div className="flex items-center gap-2">
                  {isDone ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
                      <Check className="h-4 w-4 text-emerald-600" />
                    </span>
                  ) : (
                    <Icon className="h-5 w-5 text-primary" />
                  )}
                  <h3 className="font-semibold">{step.title}</h3>
                </div>
                <p className="flex-1 text-sm text-muted-foreground">{step.body}</p>
                {isDone ? (
                  <p className="text-sm font-medium text-emerald-600">Done</p>
                ) : step.external ? (
                  <a
                    href={step.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {step.cta}
                  </a>
                ) : (
                  <Link
                    to={step.to}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {step.cta}
                  </Link>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}
