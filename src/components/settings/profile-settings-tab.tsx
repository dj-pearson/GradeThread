import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarHeart, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import type { UserUpdate } from "@/types/database";
import {
  SHIPPING_PROFILE_QUERY_KEY,
  fetchShippingProfile,
  saveShippingProfile,
} from "@/lib/shipping-profile";
import { memberSinceLabel } from "@/lib/loyalty-copy";
import { toastError } from "@/lib/toast-error";

// The Profile tab of /dashboard/settings: personal details, avatar, and the
// business + ship-from profile. Split out of settings.tsx (web-growth action 6).
export function ProfileSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // US-1442: reseller business + ship-from profile, entered once and reused
  // across marketplace/shipping flows.
  //
  // US-2417: this NO LONGER reads `profile`. business_phone and
  // ship_from_address are AES-GCM ciphertext on that row now, so the plaintext
  // only exists behind /api/account/shipping-profile. The fields start empty and
  // fill in when the query lands, which is why the effect below exists — a
  // useState initialiser would capture the pre-fetch nulls forever.
  const queryClient = useQueryClient();
  const shippingQuery = useQuery({
    queryKey: SHIPPING_PROFILE_QUERY_KEY,
    queryFn: fetchShippingProfile,
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
  });
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [shipLine1, setShipLine1] = useState("");
  const [shipLine2, setShipLine2] = useState("");
  const [shipCity, setShipCity] = useState("");
  const [shipState, setShipState] = useState("");
  const [shipPostal, setShipPostal] = useState("");
  const [shipCountry, setShipCountry] = useState("US");
  const [savingBusiness, setSavingBusiness] = useState(false);
  // Seed the form ONCE per fetched profile. Keyed on dataUpdatedAt rather than
  // on the object, so a background refetch that returns the same values does not
  // stomp on whatever the seller is halfway through typing.
  const seededAt = useRef<number | null>(null);
  useEffect(() => {
    const p = shippingQuery.data;
    if (!p || seededAt.current === shippingQuery.dataUpdatedAt) return;
    seededAt.current = shippingQuery.dataUpdatedAt;
    setBusinessName(p.business_name ?? "");
    setBusinessPhone(p.business_phone ?? "");
    setShipLine1(p.ship_from_address?.line1 ?? "");
    setShipLine2(p.ship_from_address?.line2 ?? "");
    setShipCity(p.ship_from_address?.city ?? "");
    setShipState(p.ship_from_address?.state ?? "");
    setShipPostal(p.ship_from_address?.postal_code ?? "");
    setShipCountry(p.ship_from_address?.country ?? "US");
  }, [shippingQuery.data, shippingQuery.dataUpdatedAt]);

  const initials = profile?.full_name
    ? profile.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be under 2MB");
      return;
    }

    setAvatarFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);

    try {
      let avatarUrl = profile?.avatar_url ?? null;

      if (avatarFile) {
        const ext = avatarFile.name.split(".").pop() ?? "jpg";
        const path = `${user.id}/avatar_${Date.now()}.${ext}`;

        // Avatars live in the dedicated PUBLIC `avatars` bucket (US-572).
        // The private `submission-images` bucket is signed-URL-only per the
        // CLAUDE.md storage contract and must never be served via getPublicUrl.
        const { error: uploadError } = await supabase.storage
          .from("avatars")
          .upload(path, avatarFile, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from("avatars")
          .getPublicUrl(path);

        avatarUrl = urlData.publicUrl;
      }

      const updateData: UserUpdate = { full_name: fullName.trim() || null, avatar_url: avatarUrl };
      const { error } = await supabase
        .from("users")
        .update(updateData as never)
        .eq("id", user.id);

      if (error) throw error;

      await refreshProfile();
      setAvatarFile(null);
      setAvatarPreview(null);
      toast.success("Profile updated successfully");
    } catch (err) {
      toastError(err, "Failed to update profile");
    } finally {
      setSaving(false);
    }
  }

  // US-1442: the business + ship-from profile, entered once and reused across
  // the marketplace and shipping flows. A partial fill (just a ZIP) is valid.
  //
  // US-2417: this used to be a supabase-js update straight onto users. It cannot
  // be any more — the phone and the address are encrypted with an edge-only key,
  // and 00567 dropped both columns from the self-update allowlist, so a direct
  // write now RAISES rather than quietly storing plaintext over the ciphertext.
  // business_name rides along in the same request because one Save button should
  // be one request.
  async function handleSaveBusiness() {
    if (!user) return;
    setSavingBusiness(true);
    try {
      const addr = {
        line1: shipLine1.trim() || null,
        line2: shipLine2.trim() || null,
        city: shipCity.trim() || null,
        state: shipState.trim() || null,
        postal_code: shipPostal.trim() || null,
        country: shipCountry.trim() || null,
      };
      const hasAddr = Object.values(addr).some((v) => v);
      const saved = await saveShippingProfile({
        business_name: businessName.trim() || null,
        business_phone: businessPhone.trim() || null,
        ship_from_address: hasAddr ? addr : null,
      });
      queryClient.setQueryData(SHIPPING_PROFILE_QUERY_KEY, saved);
      toast.success("Business & shipping details saved");
    } catch (err) {
      toastError(err, "Failed to save business details");
    } finally {
      setSavingBusiness(false);
    }
  }

  return (
    <>
          {/* Profile Section */}
          <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Profile
            {/* US-1914 AC1: "member since" flair. Read straight off the profile
                already in the store rather than from the rewards endpoint — the
                date is a fact about the account, so it should render on the
                account screen even if the whole rewards service is down. Tenure
                only ever grows, so there is nothing here that can go stale in
                the wrong direction. */}
            {memberSinceLabel(profile?.created_at) && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                <CalendarHeart className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Member since {memberSinceLabel(profile?.created_at)}
              </span>
            )}
          </CardTitle>
          <CardDescription>Update your personal information.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={avatarPreview ?? profile?.avatar_url ?? undefined} />
              <AvatarFallback className="bg-primary text-primary-foreground text-lg">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload Photo
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                JPG, PNG or WebP. Max 2MB.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarSelect}
              />
            </div>
          </div>

          <Separator />

          {/* Full Name */}
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Enter your full name"
            />
          </div>

          {/* Email (read-only) */}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={user?.email ?? ""}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed.
            </p>
          </div>

          <Button onClick={handleSaveProfile} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </CardContent>
      </Card>

          {/* US-1442: Business & Shipping — entered once, reused across
              marketplace/shipping flows (e.g. the eBay ship-from location). */}
          <Card>
            <CardHeader>
              <CardTitle>Business &amp; Shipping</CardTitle>
              <CardDescription>
                Your business details and ship-from address. Saved once and
                reused when you list or ship, so you don&apos;t re-enter them per
                marketplace.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* US-3237. These fields are SEEDED from a read, so a failed read
                  leaves them blank -- identical to never having filled them in.
                  A seller who then types over the blanks and saves replaces a
                  stored ship-from address with whatever they retyped. This is a
                  warning rather than an ErrorState because the rest of the card
                  still works; what must not happen is a silent overwrite. */}
              {shippingQuery.isError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                  <div className="space-y-1">
                    <p className="font-medium">
                      Couldn&apos;t load your saved business details
                    </p>
                    <p className="text-muted-foreground">
                      These boxes are blank because the read failed, not because
                      they are empty. Saving now would replace what is stored.{" "}
                      <button
                        type="button"
                        onClick={() => void shippingQuery.refetch()}
                        className="font-medium underline underline-offset-2"
                      >
                        {shippingQuery.isFetching ? "Retrying…" : "Try again"}
                      </button>
                    </p>
                  </div>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="businessName">Business name</Label>
                  <Input
                    id="businessName"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="Your store or business name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="businessPhone">Phone</Label>
                  <Input
                    id="businessPhone"
                    type="tel"
                    value={businessPhone}
                    onChange={(e) => setBusinessPhone(e.target.value)}
                    placeholder="(555) 555-5555"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-1">
                <p className="text-sm font-medium">Ship-from address</p>
                <p className="text-xs text-muted-foreground">
                  Used as the default location for your listings and shipments.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="shipLine1">Street address</Label>
                <Input
                  id="shipLine1"
                  value={shipLine1}
                  onChange={(e) => setShipLine1(e.target.value)}
                  placeholder="123 Main St"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shipLine2">
                  Apt / suite / unit (optional)
                </Label>
                <Input
                  id="shipLine2"
                  value={shipLine2}
                  onChange={(e) => setShipLine2(e.target.value)}
                  placeholder="Suite 200"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="shipCity">City</Label>
                  <Input
                    id="shipCity"
                    value={shipCity}
                    onChange={(e) => setShipCity(e.target.value)}
                    placeholder="Beverly Hills"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipState">State / region</Label>
                  <Input
                    id="shipState"
                    value={shipState}
                    onChange={(e) => setShipState(e.target.value)}
                    placeholder="CA"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipPostal">ZIP / postal code</Label>
                  <Input
                    id="shipPostal"
                    value={shipPostal}
                    onChange={(e) => setShipPostal(e.target.value)}
                    placeholder="90210"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipCountry">Country</Label>
                  <Input
                    id="shipCountry"
                    value={shipCountry}
                    onChange={(e) => setShipCountry(e.target.value)}
                    placeholder="US"
                  />
                </div>
              </div>

              <Button onClick={handleSaveBusiness} disabled={savingBusiness}>
                {savingBusiness && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Changes
              </Button>
            </CardContent>
          </Card>
    </>
  );
}
