import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ChipInput } from "@/components/buyer/chip-input";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { useBuyerProfile } from "@/hooks/use-buyer-profile";

// US-1798: buyer shopping-preferences editor. Reads/writes the single
// buyer_preferences row via the shared hook (the same row buyer onboarding
// seeds). Reuses measurement-prefs semantics for the unit toggle and the
// project's controlled-input + sonner conventions.

const CATEGORY_OPTIONS = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie", "jacket", "coat",
  "jeans", "pants", "shorts", "skirt", "dress", "sneakers", "boots",
  "sandals", "hat", "bag", "belt", "scarf",
];

// Condition floor presets (grade thresholds), null = no floor.
const CONDITION_FLOORS: Array<{ label: string; value: number | null }> = [
  { label: "Any condition", value: null },
  { label: "Fair & up (5.0)", value: 5.0 },
  { label: "Good & up (6.0)", value: 6.0 },
  { label: "Very Good & up (7.0)", value: 7.0 },
  { label: "Excellent & up (8.0)", value: 8.0 },
];

function dollarsFromCents(c: number | null): string {
  return c == null ? "" : String(Math.round(c) / 100);
}
function centsFromDollars(v: string): number | null {
  const n = parseFloat(v);
  if (!v.trim() || Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function BuyerSettingsPage() {
  const { preferences, isLoading, save, isSaving } = useBuyerPreferences();

  const [categories, setCategories] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [conditionFloor, setConditionFloor] = useState<number | null>(null);
  const [unit, setUnit] = useState<"in" | "cm">("in");
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyPush, setNotifyPush] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed local state once from the loaded row (null row → sensible defaults).
  useEffect(() => {
    if (isLoading || seeded) return;
    if (preferences) {
      setCategories(preferences.categories ?? []);
      setBrands(preferences.followed_brands ?? []);
      setSizes(Array.isArray(preferences.sizes?.all) ? preferences.sizes.all : []);
      setPriceMin(dollarsFromCents(preferences.price_min_cents));
      setPriceMax(dollarsFromCents(preferences.price_max_cents));
      setConditionFloor(preferences.condition_floor);
      setUnit(preferences.unit_preference);
      setNotifyEmail(preferences.notify_email);
      setNotifyPush(preferences.notify_push);
    }
    setSeeded(true);
  }, [isLoading, preferences, seeded]);

  async function handleSave() {
    try {
      await save({
        categories,
        followed_brands: brands,
        sizes: sizes.length > 0 ? { all: sizes } : {},
        price_min_cents: centsFromDollars(priceMin),
        price_max_cents: centsFromDollars(priceMax),
        condition_floor: conditionFloor,
        unit_preference: unit,
        notify_email: notifyEmail,
        notify_push: notifyPush,
      });
      toast.success("Preferences saved");
    } catch {
      toast.error("We couldn't save your preferences. Please try again.");
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Shopping preferences"
        subtitle="These personalize your condition alerts, fit predictions, and recommendations across GradeThread."
        icon={SlidersHorizontal}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">What you shop for</CardTitle>
          <CardDescription>Brands, categories, and sizes you're hunting.</CardDescription>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Match filters</CardTitle>
          <CardDescription>Bound your alerts by price and condition.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Price range (USD)</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                placeholder="Min"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
                aria-label="Minimum price"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="number"
                min={0}
                placeholder="Max"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                aria-label="Maximum price"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="condition-floor">Minimum condition</Label>
            <select
              id="condition-floor"
              value={conditionFloor ?? ""}
              onChange={(e) => setConditionFloor(e.target.value === "" ? null : parseFloat(e.target.value))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CONDITION_FLOORS.map((f) => (
                <option key={f.label} value={f.value ?? ""}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label>Measurement unit</Label>
            <div className="flex gap-2">
              {(["in", "cm"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={unit === u}
                  onClick={() => setUnit(u)}
                  className={cn(
                    "rounded-md border px-4 py-2 text-sm uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    unit === u
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notifications</CardTitle>
          <CardDescription>How we reach you when a match lists.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label htmlFor="notify-email" className="flex items-center gap-3">
            <Checkbox
              id="notify-email"
              checked={notifyEmail}
              onCheckedChange={(v) => setNotifyEmail(v === true)}
            />
            <span className="text-sm font-medium">Email me condition alerts</span>
          </label>
          <label htmlFor="notify-push" className="flex items-center gap-3">
            <Checkbox
              id="notify-push"
              checked={notifyPush}
              onCheckedChange={(v) => setNotifyPush(v === true)}
            />
            <span className="text-sm font-medium">Push notifications</span>
          </label>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save preferences
        </Button>
      </div>

      <PublicProfileCard />
    </div>
  );
}

// US-1818: opt-in public Trust Score profile. Private by default; the buyer picks
// a handle and which stats to expose, and can disable it any time.
const STAT_OPTIONS: Array<{ key: "level" | "confirmations" | "member_since"; label: string }> = [
  { key: "level", label: "Trust level" },
  { key: "confirmations", label: "Grades confirmed" },
  { key: "member_since", label: "Member since" },
];

function PublicProfileCard() {
  const { profile, isLoading, updateProfile, isUpdating } = useBuyerProfile();
  const [handle, setHandle] = useState("");
  const [show, setShow] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (profile) {
      setHandle(profile.handle ?? "");
      setShow({ ...profile.show });
    }
  }, [profile]);

  if (isLoading) return null;
  const enabled = profile?.enabled ?? false;

  async function onSave(nextEnabled: boolean) {
    try {
      await updateProfile({
        enabled: nextEnabled,
        handle: handle.trim() || null,
        show: show as { level?: boolean; confirmations?: boolean; member_since?: boolean },
      });
      toast.success(nextEnabled ? "Public profile updated." : "Public profile hidden.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update your profile.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Public Trust Score profile</CardTitle>
        <CardDescription>
          Off by default. Share a page at <code>/trust/&lt;handle&gt;</code> showing only the stats you choose.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="profile-handle">Handle</Label>
          <Input
            id="profile-handle"
            placeholder="thriftscout"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={30}
          />
        </div>
        <div className="space-y-2">
          <Label>Show on my profile</Label>
          <div className="flex flex-wrap gap-4">
            {STAT_OPTIONS.map((opt) => (
              <label key={opt.key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={show[opt.key] ?? false}
                  onCheckedChange={(v) => setShow((s) => ({ ...s, [opt.key]: v === true }))}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onSave(true)} disabled={isUpdating}>
            {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {enabled ? "Update public profile" : "Make profile public"}
          </Button>
          {enabled && (
            <Button variant="outline" onClick={() => onSave(false)} disabled={isUpdating}>
              Make private
            </Button>
          )}
          {enabled && profile?.handle && (
            <a
              href={`/trust/${profile.handle}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary underline"
            >
              View profile
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
