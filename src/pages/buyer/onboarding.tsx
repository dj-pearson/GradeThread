import { useState } from "react";
import { useNavigate } from "react-router";
import { Sparkles, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { ChipInput } from "@/components/buyer/chip-input";
import { readBuyerClaim } from "@/lib/buyer-conversion-claim";
import { CategoryPicker } from "@/components/buyer/category-picker";
import {
  SIZE_GROUPS,
  writeSizeBuckets,
  type SizeBuckets,
} from "@/lib/buyer-taxonomy";

// US-1797: buyer-first onboarding. Collects the minimum to personalize alerts /
// fit / recommendations (categories, brands, sizes, notification opt-in) and is
// fully skippable — either path stamps onboarding_completed_at so the buyer home
// stops routing here. Persists to buyer_preferences via the shared hook (US-1798
// builds the full editor on the same row at /buyer/settings).

// US-2552: the categories come from the shared taxonomy now. They used to be
// thirteen hardcoded strings — every one a real value, but an arbitrary subset,
// so a buyer hunting scarves, shorts, sandals, hats, belts, blouses, neckwear
// or gloves had no way to say so, and the list did not grow when the taxonomy
// did. See src/lib/buyer-taxonomy.ts for what matching actually compares.

export function BuyerOnboardingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { save, isSaving } = useBuyerPreferences();

  const [categories, setCategories] = useState<string[]>([]);
  // US-1843: a buyer who arrived from a free-tool estimate already told us one
  // brand they care about. Seed it rather than asking again — the claim itself
  // survives onboarding untouched and is still claimable on the buyer home.
  const [brands, setBrands] = useState<string[]>(() => {
    const brand = readBuyerClaim()?.result.brand;
    return brand ? [brand] : [];
  });
  // Per group, not one bucket: "M for tops, 32 for jeans, 10 for shoes" is what
  // a person actually has, and `{ all: [...] }` claimed one size fits every
  // category — which watchlist.ts then copied straight into a saved search.
  const [sizes, setSizes] = useState<SizeBuckets>({});
  const [notifyEmail, setNotifyEmail] = useState(true);

  const firstName = user?.user_metadata?.full_name?.split(" ")[0] ?? "there";

  async function complete(withPrefs: boolean) {
    try {
      await save(
        withPrefs
          ? {
              categories,
              followed_brands: brands,
              sizes: writeSizeBuckets(sizes),
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
          <CategoryPicker
            values={categories}
            onChange={setCategories}
            hint="These match the categories items are graded under."
          />

          <ChipInput
            label="Brands you follow"
            placeholder="e.g. Patagonia, Lululemon…"
            values={brands}
            onChange={setBrands}
          />

          <div className="space-y-4">
            <div>
              <Label>Your sizes</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Only the ones you know. A blank group just means no size filter
                there.
              </p>
            </div>
            {SIZE_GROUPS.map((group) => (
              <ChipInput
                key={group.key}
                label={group.label}
                placeholder={group.placeholder}
                values={sizes[group.key] ?? []}
                onChange={(vals) =>
                  setSizes((prev) => ({ ...prev, [group.key]: vals }))
                }
              />
            ))}
          </div>

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
