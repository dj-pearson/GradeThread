import { useState } from "react";
import { useNavigate } from "react-router";
import { Sparkles, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { ChipInput } from "@/components/buyer/chip-input";

// US-1797: buyer-first onboarding. Collects the minimum to personalize alerts /
// fit / recommendations (categories, brands, sizes, notification opt-in) and is
// fully skippable — either path stamps onboarding_completed_at so the buyer home
// stops routing here. Persists to buyer_preferences via the shared hook (US-1798
// builds the full editor on the same row at /buyer/settings).

const CATEGORY_OPTIONS = [
  "t-shirt", "shirt", "sweater", "hoodie", "jacket", "coat",
  "jeans", "pants", "dress", "skirt", "sneakers", "boots", "bag",
];

export function BuyerOnboardingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { save, isSaving } = useBuyerPreferences();

  const [categories, setCategories] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [notifyEmail, setNotifyEmail] = useState(true);

  const firstName = user?.user_metadata?.full_name?.split(" ")[0] ?? "there";

  async function complete(withPrefs: boolean) {
    try {
      await save(
        withPrefs
          ? {
              categories,
              followed_brands: brands,
              sizes: sizes.length > 0 ? { all: sizes } : {},
              notify_email: notifyEmail,
              onboarding_completed_at: new Date().toISOString(),
            }
          : { onboarding_completed_at: new Date().toISOString() },
      );
      navigate("/buyer", { replace: true });
    } catch {
      toast.error("We couldn't save your preferences. Please try again.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6">
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <h1 className="mt-4 text-2xl font-bold">Welcome, {firstName}</h1>
        <p className="mt-2 text-muted-foreground">
          Tell us what you shop for and we'll personalize your alerts, fit, and
          recommendations. You can change any of this later in Settings.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">What are you hunting for?</CardTitle>
          <CardDescription>All optional — pick what's useful, skip the rest.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Categories</Label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((c) => {
                const selected = categories.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setCategories((prev) =>
                        prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
                      )
                    }
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm capitalize transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          <ChipInput
            label="Brands you follow"
            placeholder="e.g. Patagonia, Lululemon…"
            values={brands}
            onChange={setBrands}
          />

          <ChipInput
            label="Your sizes"
            placeholder="e.g. M, 32x30, US 10…"
            values={sizes}
            onChange={setSizes}
          />

          <label htmlFor="notify-email" className="flex items-start gap-3">
            <Checkbox
              id="notify-email"
              checked={notifyEmail}
              onCheckedChange={(v) => setNotifyEmail(v === true)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium leading-none">Email me condition alerts</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Get notified when a graded item in your brands and sizes lists. Change anytime.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => complete(false)} disabled={isSaving}>
          Skip for now
        </Button>
        <Button onClick={() => complete(true)} disabled={isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save &amp; continue
        </Button>
      </div>
    </div>
  );
}
