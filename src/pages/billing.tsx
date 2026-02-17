import { useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";
import { Check, Crown, Loader2, ExternalLink, CalendarClock } from "lucide-react";
import { toast } from "sonner";

const EDGE_URL = import.meta.env.VITE_SUPABASE_URL
  ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, "")}`
  : "";

const PLAN_ORDER: PlanKey[] = ["free", "starter", "professional", "enterprise"];

function getPlanIndex(plan: PlanKey): number {
  return PLAN_ORDER.indexOf(plan);
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function BillingPage() {
  const { profile } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const currentPlan = (profile?.plan ?? "free") as PlanKey;
  const currentPlanConfig = PLANS[currentPlan];
  const gradesUsed = profile?.grades_used_this_month ?? 0;
  const gradesLimit = currentPlanConfig.gradesPerMonth === -1
    ? "Unlimited"
    : currentPlanConfig.gradesPerMonth;
  const gradesPercent =
    typeof gradesLimit === "number" ? Math.round((gradesUsed / gradesLimit) * 100) : 0;

  const gradeResetAt = profile?.grade_reset_at
    ? new Date(profile.grade_reset_at)
    : null;

  async function handleUpgrade(plan: PlanKey) {
    if (plan === "enterprise") {
      window.location.href = "mailto:sales@gradethread.com?subject=Enterprise%20Plan%20Inquiry";
      return;
    }

    setLoadingPlan(plan);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${EDGE_URL}/api/payments/subscribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ plan }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to create checkout session");
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      setLoadingPlan(null);
    }
  }

  async function handleManageSubscription() {
    setPortalLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${EDGE_URL}/api/payments/portal`, {
        method: "POST",
        headers,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to open billing portal");
      }

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open billing portal");
    } finally {
      setPortalLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-muted-foreground">Manage your subscription and billing.</p>
      </div>

      {/* Current plan + usage */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Current Plan: {currentPlanConfig.name}</CardTitle>
              <CardDescription>
                {currentPlanConfig.priceMonthly === 0
                  ? "You are on the free plan."
                  : currentPlanConfig.priceMonthly === null
                    ? "Custom enterprise pricing."
                    : `$${currentPlanConfig.priceMonthly}/month`}
              </CardDescription>
            </div>
            {currentPlan !== "free" && profile?.stripe_customer_id && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-2 h-4 w-4" />
                )}
                Manage Subscription
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Grades used this month</span>
              <span className="text-muted-foreground">
                {gradesUsed} / {gradesLimit}
              </span>
            </div>
            {typeof gradesLimit === "number" && (
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-brand-navy transition-all"
                  style={{ width: `${Math.min(gradesPercent, 100)}%` }}
                />
              </div>
            )}
          </div>

          {gradeResetAt && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              <span>
                Grades reset on{" "}
                {gradeResetAt.toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </div>
          )}

          <Separator />

          <ul className="space-y-1">
            {currentPlanConfig.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-600" />
                {feature}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Plan comparison grid */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Compare Plans</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((planKey) => {
            const plan = PLANS[planKey];
            const isCurrent = planKey === currentPlan;
            const isUpgrade = getPlanIndex(planKey) > getPlanIndex(currentPlan);
            const isDowngrade = getPlanIndex(planKey) < getPlanIndex(currentPlan);

            return (
              <Card
                key={planKey}
                className={
                  isCurrent
                    ? "border-brand-navy border-2"
                    : ""
                }
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{plan.name}</CardTitle>
                    {isCurrent && (
                      <Badge variant="default" className="bg-brand-navy">
                        Current
                      </Badge>
                    )}
                    {planKey === "professional" && !isCurrent && (
                      <Badge variant="secondary">
                        <Crown className="mr-1 h-3 w-3" />
                        Popular
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2">
                    {plan.priceMonthly === 0 ? (
                      <span className="text-3xl font-bold">Free</span>
                    ) : plan.priceMonthly === null ? (
                      <span className="text-3xl font-bold">Custom</span>
                    ) : (
                      <div>
                        <span className="text-3xl font-bold">${plan.priceMonthly}</span>
                        <span className="text-muted-foreground">/month</span>
                      </div>
                    )}
                  </div>
                  <CardDescription>
                    {plan.gradesPerMonth === -1
                      ? "Unlimited grades"
                      : `${plan.gradesPerMonth} grades per month`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-3">
                  <ul className="space-y-2">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-sm">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  {isCurrent ? (
                    <Button className="w-full" variant="outline" disabled>
                      Current Plan
                    </Button>
                  ) : isUpgrade ? (
                    <Button
                      className="w-full"
                      onClick={() => handleUpgrade(planKey)}
                      disabled={loadingPlan !== null}
                    >
                      {loadingPlan === planKey && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {planKey === "enterprise" ? "Contact Sales" : "Upgrade"}
                    </Button>
                  ) : isDowngrade && profile?.stripe_customer_id ? (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={handleManageSubscription}
                      disabled={portalLoading}
                    >
                      {portalLoading && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Manage Plan
                    </Button>
                  ) : (
                    <Button className="w-full" variant="outline" disabled>
                      {isDowngrade ? "Downgrade via Portal" : "Current Plan"}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
