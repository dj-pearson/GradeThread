import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";

export function BillingPage() {
  const { profile } = useAuth();
  const plan = profile?.plan ?? "free";
  const planConfig = PLANS[plan as PlanKey];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-muted-foreground">Manage your subscription and billing.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current Plan: {planConfig.name}</CardTitle>
          <CardDescription>
            {planConfig.priceMonthly === 0
              ? "You are on the free plan."
              : planConfig.priceMonthly === null
                ? "Custom enterprise pricing."
                : `$${planConfig.priceMonthly}/month`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1">
            {planConfig.features.map((feature) => (
              <li key={feature} className="text-sm text-muted-foreground">
                &#x2713; {feature}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Plan upgrades and Stripe checkout coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
