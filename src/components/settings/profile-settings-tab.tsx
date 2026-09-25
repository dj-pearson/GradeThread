import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarHeart, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@/hooks/use-auth";
import { useReportSettingsDirty } from "@/hooks/use-settings-dirty";
import { useMissingTooLong } from "@/hooks/use-missing-too-long";
import { supabase } from "@/lib/supabase";
import type { UserUpdate } from "@/types/database";
import {
  SHIPPING_PROFILE_QUERY_KEY,
  fetchShippingProfile,
  saveShippingProfile,
  type ShippingProfile,
} from "@/lib/shipping-profile";
import { isHeicFile, normalizeToImageFile } from "@/lib/media-intake";
import { compressImage } from "@/lib/image-utils";
import {
  AVATAR_ACCEPT,
  AVATAR_MAX_INPUT_BYTES,
  ownAvatarPath,
} from "@/lib/avatar-path";
import { memberSinceLabel } from "@/lib/loyalty-copy";
import { toastError } from "@/lib/toast-error";

interface BusinessForm {
  businessName: string;
  businessPhone: string;
  shipLine1: string;
  shipLine2: string;
  shipCity: string;
  shipState: string;
  shipPostal: string;
  shipCountry: string;
}

const EMPTY_BUSINESS: BusinessForm = {
  businessName: "",
  businessPhone: "",
  shipLine1: "",
  shipLine2: "",
  shipCity: "",
  shipState: "",
  shipPostal: "",
  shipCountry: "US",
};

function businessFromProfile(p: ShippingProfile | null | undefined): BusinessForm {
  if (!p) return EMPTY_BUSINESS;
  return {
    businessName: p.business_name ?? "",
    businessPhone: p.business_phone ?? "",
    shipLine1: p.ship_from_address?.line1 ?? "",
    shipLine2: p.ship_from_address?.line2 ?? "",
    shipCity: p.ship_from_address?.city ?? "",
    shipState: p.ship_from_address?.state ?? "",
    shipPostal: p.ship_from_address?.postal_code ?? "",
    shipCountry: p.ship_from_address?.country ?? "US",
  };
}

function sameBusiness(a: BusinessForm, b: BusinessForm): boolean {
  return (Object.keys(a) as Array<keyof BusinessForm>).every((k) => a[k] === b[k]);
}

// Best effort: a failed delete leaves an orphaned object, which is logged but
// never blocks or toasts, because the profile change itself already succeeded.
async function removeAvatarObject(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from("avatars").remove([path]);
    if (error) console.warn("[avatar] could not remove", path, error.message);
  } catch (err) {
    console.warn("[avatar] could not remove", path, err);
  }
}

// The Profile tab of /dashboard/settings: personal details, avatar, and the
// business + ship-from profile. Split out of settings.tsx (web-growth action 6).
export function ProfileSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();
  const profileFailed = useMissingTooLong(!profile);

  // Seeded from the profile rather than captured once: the profile can arrive
  // after this tab mounts, and a useState initialiser would keep the pre-load
  // null forever and Save would then write it over the stored name. Re-seeded
  // when the row itself changes (id / updated_at), and never while the field
  // holds unsaved typing.
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [seededName, setSeededName] = useState(profile?.full_name ?? "");
  const nameDirty = fullName !== seededName;
  const nameDirtyRef = useRef(nameDirty);
  nameDirtyRef.current = nameDirty;
  const profileId = profile?.id;
  const profileUpdatedAt = profile?.updated_at;
  const profileFullName = profile?.full_name ?? "";
  useEffect(() => {
    if (!profileId || nameDirtyRef.current) return;
    setFullName(profileFullName);
    setSeededName(profileFullName);
  }, [profileId, profileUpdatedAt, profileFullName]);

  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [retryingProfile, setRetryingProfile] = useState(false);
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
    // A reconnect refetch would otherwise arrive mid-edit on a flaky connection.
    refetchOnReconnect: false,
  });
  const [business, setBusiness] = useState<BusinessForm>(EMPTY_BUSINESS);
  const [seededBusiness, setSeededBusiness] =
    useState<BusinessForm>(EMPTY_BUSINESS);
  const businessDirty = !sameBusiness(business, seededBusiness);
  const businessDirtyRef = useRef(businessDirty);
  businessDirtyRef.current = businessDirty;
  const [savingBusiness, setSavingBusiness] = useState(false);
  useReportSettingsDirty("profile", nameDirty);
  useReportSettingsDirty("business", businessDirty);
  // Blank boxes while the read is pending or failed are not the stored values,
  // so nothing may be typed over them or saved from them (US-3237).
  const businessLocked = shippingQuery.isPending || shippingQuery.isError;
  function setField<K extends keyof BusinessForm>(key: K, value: string) {
    setBusiness((b) => ({ ...b, [key]: value }));
  }
  // Seed the form from each fetched profile, but only while the form is clean.
  // Keyed on dataUpdatedAt so a refetch returning the same values is a no-op,
  // and skipped when dirty so a background refetch never erases typing.
  const seededAt = useRef<number | null>(null);
  useEffect(() => {
    const p = shippingQuery.data;
    if (!p || seededAt.current === shippingQuery.dataUpdatedAt) return;
    if (businessDirtyRef.current) return;
    seededAt.current = shippingQuery.dataUpdatedAt;
    const next = businessFromProfile(p);
    setBusiness(next);
    setSeededBusiness(next);
  }, [shippingQuery.data, shippingQuery.dataUpdatedAt]);

  const initials = profile?.full_name
    ? profile.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  async function handleRetryProfile() {
    setRetryingProfile(true);
    try {
      await refreshProfile();
    } finally {
      setRetryingProfile(false);
    }
  }

  function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    const decodable =
      ["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      isHeicFile(file);
    if (!decodable) {
      toast.error("Please choose a JPG, PNG, WebP or HEIC photo");
      return;
    }
    if (file.size > AVATAR_MAX_INPUT_BYTES) {
      toast.error("That photo is too large. Choose one under 20MB.");
      return;
    }
    void uploadAvatar(file);
  }

  // The avatars bucket is PUBLIC (US-572), so what goes up is what anyone can
  // fetch. The photo is ALWAYS re-encoded on a canvas first: that drops EXIF,
  // including the GPS a phone selfie carries (the US-276 rule), and it sets the
  // type from the encoded bytes rather than from the filename. There is no
  // fallback to the original file; a photo that cannot be re-encoded is not
  // uploaded at all.
  async function uploadAvatar(file: File) {
    if (!user || !profile) return;
    setAvatarBusy(true);
    let blob: Blob;
    try {
      const decodable = await normalizeToImageFile(file);
      ({ blob } = await compressImage(decodable, {
        maxEdge: 512,
        outputType: "image/webp",
      }));
    } catch {
      toast.error("Couldn't process that photo. Try a different one.");
      setAvatarBusy(false);
      return;
    }
    const contentType = blob.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const ext = contentType === "image/jpeg" ? "jpg" : "webp";
    const path = `${user.id}/avatar_${Date.now()}.${ext}`;
    const previousPath = ownAvatarPath(profile.avatar_url, user.id);
    try {
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, blob, { upsert: false, contentType });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(path);
      const updateData: UserUpdate = { avatar_url: urlData.publicUrl };
      const { error } = await supabase
        .from("users")
        .update(updateData as never)
        .eq("id", user.id);
      if (error) {
        // The row still points at the old photo; do not leave an orphan.
        await removeAvatarObject(path);
        throw error;
      }
      // Only after the row points at the new photo: the old one would
      // otherwise stay publicly reachable forever.
      if (previousPath && previousPath !== path) {
        await removeAvatarObject(previousPath);
      }
      await refreshProfile();
      toast.success("Photo updated");
    } catch (err) {
      toastError(err, "Failed to update photo");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleRemoveAvatar() {
    if (!user || !profile?.avatar_url) return;
    setAvatarBusy(true);
    const previousPath = ownAvatarPath(profile.avatar_url, user.id);
    try {
      const updateData: UserUpdate = { avatar_url: null };
      const { error } = await supabase
        .from("users")
        .update(updateData as never)
        .eq("id", user.id);
      if (error) throw error;
      if (previousPath) await removeAvatarObject(previousPath);
      await refreshProfile();
      toast.success("Photo removed");
    } catch (err) {
      toastError(err, "Failed to remove photo");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSaveProfile() {
    if (!user || !profile || !nameDirty) return;
    setSaving(true);

    try {
      // Only the changed field. The avatar saves on its own when picked.
      const nextName = fullName.trim() || null;
      const updateData: UserUpdate = { full_name: nextName };
      const { error } = await supabase
        .from("users")
        .update(updateData as never)
        .eq("id", user.id);

      if (error) throw error;

      setSeededName(nextName ?? "");
      setFullName(nextName ?? "");
      await refreshProfile();
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
    if (!user || businessLocked) return;
    setSavingBusiness(true);
    try {
      const addr = {
        line1: business.shipLine1.trim() || null,
        line2: business.shipLine2.trim() || null,
        city: business.shipCity.trim() || null,
        state: business.shipState.trim() || null,
        postal_code: business.shipPostal.trim() || null,
        country: business.shipCountry.trim() || null,
      };
      // Country alone is not an address: it defaults to "US", so counting it
      // stored {country:"US"} on a name-only save.
      const { country: _country, ...addrLines } = addr;
      void _country;
      const hasAddr = Object.values(addrLines).some((v) => v);
      const saved = await saveShippingProfile({
        business_name: business.businessName.trim() || null,
        business_phone: business.businessPhone.trim() || null,
        ship_from_address: hasAddr ? addr : null,
      });
      const next = businessFromProfile(saved);
      setBusiness(next);
      setSeededBusiness(next);
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
          {!profile && !profileFailed && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading your profile…
            </p>
          )}
          {profileFailed && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="font-medium">Couldn&apos;t load your profile</p>
                <p className="text-muted-foreground">
                  Saving is off until it loads, so nothing stored is replaced
                  with a blank.{" "}
                  <button
                    type="button"
                    onClick={() => void handleRetryProfile()}
                    disabled={retryingProfile}
                    className="font-medium underline underline-offset-2"
                  >
                    {retryingProfile ? "Retrying…" : "Retry"}
                  </button>
                </p>
              </div>
            </div>
          )}

          {/* Avatar: saves as soon as a photo is picked, on its own. */}
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={profile?.avatar_url ?? undefined} />
              <AvatarFallback className="bg-primary text-primary-foreground text-lg">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!profile || avatarBusy}
                >
                  {avatarBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {profile?.avatar_url ? "Change photo" : "Upload photo"}
                </Button>
                {profile?.avatar_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRemoveAvatar()}
                    disabled={avatarBusy}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove photo
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                JPG, PNG, WebP or HEIC. Saved right away, resized to 512px, and
                location data is removed.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
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
              disabled={!profile}
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

          <Button
            onClick={handleSaveProfile}
            disabled={saving || !profile || !nameDirty}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save profile
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
              {shippingQuery.isPending ? (
                <div
                  className="space-y-3"
                  aria-busy="true"
                  aria-label="Loading business details"
                >
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-2/3" />
                </div>
              ) : (
                <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="businessName">Business name</Label>
                  <Input
                    id="businessName"
                    value={business.businessName}
                    onChange={(e) => setField("businessName", e.target.value)}
                    disabled={businessLocked}
                    placeholder="Your store or business name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="businessPhone">Phone</Label>
                  <Input
                    id="businessPhone"
                    type="tel"
                    value={business.businessPhone}
                    onChange={(e) => setField("businessPhone", e.target.value)}
                    disabled={businessLocked}
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
                  value={business.shipLine1}
                  onChange={(e) => setField("shipLine1", e.target.value)}
                  disabled={businessLocked}
                  placeholder="123 Main St"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shipLine2">
                  Apt / suite / unit (optional)
                </Label>
                <Input
                  id="shipLine2"
                  value={business.shipLine2}
                  onChange={(e) => setField("shipLine2", e.target.value)}
                  disabled={businessLocked}
                  placeholder="Suite 200"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="shipCity">City</Label>
                  <Input
                    id="shipCity"
                    value={business.shipCity}
                    onChange={(e) => setField("shipCity", e.target.value)}
                    disabled={businessLocked}
                    placeholder="Beverly Hills"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipState">State / region</Label>
                  <Input
                    id="shipState"
                    value={business.shipState}
                    onChange={(e) => setField("shipState", e.target.value)}
                    disabled={businessLocked}
                    placeholder="CA"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipPostal">ZIP / postal code</Label>
                  <Input
                    id="shipPostal"
                    value={business.shipPostal}
                    onChange={(e) => setField("shipPostal", e.target.value)}
                    disabled={businessLocked}
                    placeholder="90210"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shipCountry">Country</Label>
                  <Input
                    id="shipCountry"
                    value={business.shipCountry}
                    onChange={(e) => setField("shipCountry", e.target.value)}
                    disabled={businessLocked}
                    placeholder="US"
                  />
                </div>
              </div>

                </>
              )}

              <Button
                onClick={handleSaveBusiness}
                disabled={savingBusiness || businessLocked || !businessDirty}
              >
                {savingBusiness && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save business details
              </Button>
            </CardContent>
          </Card>
    </>
  );
}
