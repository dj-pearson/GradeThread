import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { usePageHost } from "@/hooks/use-page-host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { downloadBlob } from "@/lib/download";
import type {
  UserUpdate,
  NotificationPreferences,
  NotificationChannel,
} from "@/types/database";
import {
  NOTIFICATION_TYPES,
  withPreferenceDefaults,
} from "@/lib/notification-preferences";
import { buildAccountExport } from "@/lib/account-export";
import {
  SHIPPING_PROFILE_QUERY_KEY,
  fetchShippingProfile,
  saveShippingProfile,
} from "@/lib/shipping-profile";
import { FLIPDESK_PLANS, flipdeskPlanForLegacy, type PlanKey } from "@/lib/constants";
import { effectiveAiLimit as computeEffectiveAiLimit } from "@/lib/ai-limit";
import {
  Loader2,
  Upload,
  Download,
  Sparkles,
  Compass,
  Archive,
  AlertTriangle,
  User,
  Shield,
  Bell,
  CalendarHeart,
} from "lucide-react";
import { memberSinceLabel } from "@/lib/loyalty-copy";
import { toast } from "sonner";
import { toastError, toastWarning } from "@/lib/toast-error";
import { PromotedListingsDefaultCard } from "@/components/flipdesk/promoted-listings-default-card";
import { ListingDefaultsCard } from "@/components/flipdesk/listing-defaults-card";
import { useOnboardingTourStore } from "@/stores/onboarding-tour-store";
import { useActivation } from "@/hooks/use-activation";
import { useArchivePhotos } from "@/hooks/use-image-archive";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders, edgeFetch } from "@/lib/edge-fetch";
import { signOut, signOutEverywhere, signOutOtherSessions } from "@/lib/auth";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { FieldError } from "@/components/ui/form-feedback";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MfaCard } from "@/components/settings/mfa-card";
import { PushNotificationsCard } from "@/components/settings/push-notifications-card";
import { QuietHoursCard } from "@/components/settings/quiet-hours-card";
import { RadarContributionCard } from "@/components/settings/radar-contribution-card";

const DELETE_CONFIRM_PHRASE = "DELETE MY ACCOUNT";

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function nextResetLabel(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric" }
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  in_app: "In-app",
  push: "Push",
};

// US-608: settings are split into deep-linkable tabs (?tab=<value>) so a long
// single scroll becomes findable sections. Order here drives the tab strip.
const SETTINGS_TABS = [
  { value: "profile", label: "Profile", icon: User },
  { value: "security", label: "Security", icon: Shield },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "ai", label: "AI", icon: Sparkles },
  { value: "flipdesk", label: "FlipDesk", icon: Compass },
  { value: "data", label: "Data", icon: Download },
  { value: "storage", label: "Storage", icon: Archive },
  { value: "danger", label: "Danger", icon: AlertTriangle },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
const SETTINGS_TAB_VALUES = SETTINGS_TABS.map((t) => t.value) as SettingsTab[];
const DEFAULT_SETTINGS_TAB: SettingsTab = "profile";

export function SettingsPage() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const { embedded } = usePageHost();
  const [searchParams, setSearchParams] = useSearchParams();
  // US-2859: the FlipDesk checklist is not a separate tour any more; replaying
  // it means bringing the one activation checklist back.
  const { undismiss: undismissActivation } = useActivation();
  const openWelcomeTour = useOnboardingTourStore((s) => s.open);

  // Deep-linkable section: ?tab=security, etc. Unknown/missing → Profile.
  const tabParam = searchParams.get("tab");
  const activeTab: SettingsTab = SETTINGS_TAB_VALUES.includes(
    tabParam as SettingsTab
  )
    ? (tabParam as SettingsTab)
    : DEFAULT_SETTINGS_TAB;

  function handleTabChange(next: string) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true }
    );
  }

  function replayFlipdeskTour() {
    undismissActivation();
    navigate("/dashboard/flipdesk");
  }

  function replayWelcomeTour() {
    openWelcomeTour();
    navigate("/dashboard");
  }

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

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<NotificationPreferences>(() =>
    withPreferenceDefaults(profile?.notification_preferences)
  );
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [filingRequest, setFilingRequest] = useState<"export" | "delete" | null>(null);
  const [exportStage, setExportStage] = useState("");
  const [exportPct, setExportPct] = useState(0);

  const [aiEnabled, setAiEnabled] = useState(
    profile?.ai_enrichment_enabled ?? true
  );
  const [aiLimit, setAiLimit] = useState(
    profile?.ai_action_limit != null ? String(profile.ai_action_limit) : ""
  );
  const [savingAi, setSavingAi] = useState(false);

  const [shareOutcomes, setShareOutcomes] = useState(
    profile?.share_sale_outcomes ?? false
  );
  const [savingShareOutcomes, setSavingShareOutcomes] = useState(false);

  // Usage-alert thresholds (US-209). Percentages of any plan cap at which a
  // soft upgrade toast fires. Default [80]; the chooser offers 50/80/95.
  const [alertThresholds, setAlertThresholds] = useState<number[]>(() =>
    profile?.usage_alert_thresholds && profile.usage_alert_thresholds.length > 0
      ? profile.usage_alert_thresholds
      : [80]
  );
  const [savingAlerts, setSavingAlerts] = useState(false);

  // FlipDesk plan drives the AI allowance (US-202). Fall back to the legacy
  // US-2365: the un-backfilled fallback now translates the legacy column
  // explicitly instead of going through the deprecated PLANS shim. Same
  // numbers — the shim only ever derived them from FLIPDESK_PLANS — but the
  // translation is visible rather than hidden behind an alias.
  const flipdeskPlan = profile?.flipdesk_plan ??
    flipdeskPlanForLegacy((profile?.plan ?? "free") as PlanKey);
  const planAiLimit = FLIPDESK_PLANS[flipdeskPlan].aiActionsPerMonth;
  // US-1631: same min-of-plan-and-user-cap semantics as billing / usage meters
  // (previously `userLimit ?? plan`, which disagreed when a user's cap exceeded
  // the plan).
  const effectiveAiLimit = computeEffectiveAiLimit(planAiLimit, profile?.ai_action_limit ?? null);
  const aiUsed = profile?.ai_actions_used_this_month ?? 0;
  const aiUnlimited = effectiveAiLimit < 0;
  const aiPct =
    !aiUnlimited && effectiveAiLimit > 0
      ? Math.min(100, Math.round((aiUsed / effectiveAiLimit) * 100))
      : 0;

  const isOAuthUser = user?.app_metadata?.provider === "google";

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

  async function handleChangePassword() {
    setPasswordError(null);
    if (!newPassword || !confirmPassword) {
      setPasswordError("Please fill in all password fields.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      document.getElementById("confirmPassword")?.focus();
      return;
    }

    // US-367: enforce the shared password policy (was a weaker 6-char check).
    const pwCheck = checkPassword(newPassword);
    if (!pwCheck.ok) {
      setPasswordError(
        pwCheck.reason ?? "Password does not meet the requirements.",
      );
      document.getElementById("newPassword")?.focus();
      return;
    }

    setChangingPassword(true);

    try {
      // US-375: re-authenticate with the current password (recent re-auth gate
      // for this sensitive action) before changing it.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user?.email ?? "",
        password: currentPassword,
      });

      if (signInError) {
        toast.error("Current password is incorrect");
        return;
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) throw error;

      // US-375: a password change must revoke other sessions so a stolen one
      // can't survive. Keep the current session active. Best-effort.
      await signOutOtherSessions().catch(() => {});

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated. Other devices have been signed out.");
    } catch (err) {
      toastError(err, "Failed to update password");
    } finally {
      setChangingPassword(false);
    }
  }

  function setChannel(
    typeKey: keyof NotificationPreferences,
    channel: NotificationChannel,
    value: boolean
  ) {
    setPrefs((prev) => {
      const current = prev[typeKey] as Record<string, boolean>;
      return {
        ...prev,
        [typeKey]: { ...current, [channel]: value },
      } as NotificationPreferences;
    });
  }

  async function handleSavePreferences() {
    if (!user) return;
    setSavingPrefs(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({ notification_preferences: prefs } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success("Notification preferences saved");
    } catch (err) {
      toastError(err, "Failed to save preferences");
    } finally {
      setSavingPrefs(false);
    }
  }

  function toggleAlertThreshold(t: number) {
    setAlertThresholds((prev) =>
      prev.includes(t)
        ? prev.filter((x) => x !== t)
        : [...prev, t].sort((a, b) => a - b)
    );
  }

  async function handleSaveAlertThresholds() {
    setSavingAlerts(true);
    try {
      const res = await edgeFetch("/api/payments/usage-alerts", {
        method: "POST",
        json: { thresholds: alertThresholds },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to save usage alert settings.");
      }
      // Server normalizes (dedupes/sorts, empty → default 80).
      if (Array.isArray(json.thresholds)) setAlertThresholds(json.thresholds);
      await refreshProfile();
      toast.success("Usage alert settings saved.");
    } catch (err) {
      toastError(err, "Failed to save usage alert settings.");
    } finally {
      setSavingAlerts(false);
    }
  }

  async function handleSaveShareOutcomes(next: boolean) {
    if (!user) return;
    setSavingShareOutcomes(true);
    setShareOutcomes(next);
    try {
      const { error } = await supabase
        .from("users")
        .update({ share_sale_outcomes: next } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(
        next
          ? "Thanks — your sale outcomes will help improve AI grading."
          : "Sale-outcome sharing turned off."
      );
    } catch (err) {
      // Revert the optimistic flip if the save fails.
      setShareOutcomes(!next);
      toastError(err, "Failed to update sale-outcome sharing.");
    } finally {
      setSavingShareOutcomes(false);
    }
  }

  async function handleSaveAiSettings() {
    if (!user) return;
    const trimmed = aiLimit.trim();
    // US-1631: a blank field clears the personal cap (plan default). Otherwise
    // require a whole number — previously `parseInt("abc") || 0` silently saved a
    // HARD 0 cap (blocking ALL AI actions) on a typo. "0" is still allowed as an
    // intentional "disable AI" cap.
    if (trimmed !== "" && !/^\d+$/.test(trimmed)) {
      toast.error(
        "Enter a whole number for the AI action cap, or leave it blank for the plan default.",
      );
      return;
    }
    const limitVal = trimmed === "" ? null : Number.parseInt(trimmed, 10);
    setSavingAi(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({
          ai_enrichment_enabled: aiEnabled,
          ai_action_limit: limitVal,
        } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success("AI assistant settings saved.");
    } catch (err) {
      toastError(err, "Failed to save AI settings.");
    } finally {
      setSavingAi(false);
    }
  }

  async function handleExportData() {
    if (!user) return;
    const key = `gt-last-export-${user.id}`;
    const last = Number(localStorage.getItem(key) ?? 0);
    const sinceLast = Date.now() - last;
    if (last && sinceLast < EXPORT_COOLDOWN_MS) {
      const hours = Math.ceil((EXPORT_COOLDOWN_MS - sinceLast) / 3600000);
      toast.error(
        `You can export once per day. Try again in about ${hours} hour${
          hours === 1 ? "" : "s"
        }.`
      );
      return;
    }

    setExporting(true);
    setExportPct(0);
    setExportStage("Starting…");
    try {
      const blob = await buildAccountExport((stage, pct) => {
        setExportStage(stage);
        setExportPct(pct);
      });
      localStorage.setItem(key, String(Date.now()));

      downloadBlob(
        blob,
        `gradethread-export-${new Date().toISOString().split("T")[0]}.zip`,
      );

      toast.success("Your data export has been downloaded.");
    } catch (err) {
      toastError(err, "Failed to export data.");
    } finally {
      setExporting(false);
    }
  }

  // US-903: file a formal GDPR/CCPA data-subject request (export or deletion).
  // Unlike the instant export above, this lands an audited, tracked request in
  // the compliance queue for an operator to fulfill.
  async function handleFileDataRequest(type: "export" | "delete") {
    setFilingRequest(type);
    try {
      const res = await edgeFetch("/api/account/data-requests", {
        method: "POST",
        json: { type },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to file your request.");
      }
      toast.success(
        type === "export"
          ? "Data export request filed. We'll process it and email you."
          : "Deletion request filed. Our team will process it.",
      );
    } catch (err) {
      toastError(err, "Failed to file request.");
    } finally {
      setFilingRequest(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Manage your account settings."
      />

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="space-y-6"
      >
        {/* US-1441: inside the Account hub, the hub's tab strip sits directly
            above these. Rendering both as identical pill strips reads as two
            stacked tab bars, so switch these to an underline sub-nav that's
            clearly secondary to (not a sibling of) the hub tabs. */}
        <TabsList
          className={cn(
            "h-auto w-full flex-wrap justify-start",
            embedded &&
              "gap-1 rounded-none border-b bg-transparent p-0",
          )}
        >
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className={cn(
                embedded &&
                  "rounded-none border-b-2 border-transparent bg-transparent px-3 pb-2 shadow-none data-[state=active]:border-brand-navy data-[state=active]:bg-transparent data-[state=active]:shadow-none",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
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

        </TabsContent>

        <TabsContent value="notifications" className="space-y-6">
          {/* Notification Preferences Section.
              US-2102: id="email-preferences" is the anchor every unsubscribe /
              preference email links to (accountPreferenceCenterUrl). It pointed
              at /dashboard/account#email-preferences, which existed nowhere —
              so the advertised opt-out path dead-ended. The anchor lives here
              because this is where the controls actually are. */}
          <Card id="email-preferences" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Choose which notifications you receive and how.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {NOTIFICATION_TYPES.map((type, index) => (
            <div key={type.key}>
              {index > 0 && <Separator className="mb-4" />}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{type.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {type.description}
                  </p>
                </div>
                <div className="flex gap-4">
                  {type.channels.map((channel) => {
                    const checked =
                      (prefs[type.key] as Record<string, boolean>)[channel] ??
                      false;
                    const switchId = `${type.key}-${channel}`;
                    return (
                      <div
                        key={channel}
                        className="flex items-center gap-2"
                      >
                        <Switch
                          id={switchId}
                          checked={checked}
                          onCheckedChange={(value) =>
                            setChannel(type.key, channel, value)
                          }
                        />
                        <Label
                          htmlFor={switchId}
                          className="text-xs text-muted-foreground"
                        >
                          {CHANNEL_LABELS[channel]}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}

          <Button onClick={handleSavePreferences} disabled={savingPrefs}>
            {savingPrefs && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Preferences
          </Button>
        </CardContent>
      </Card>

      {/* Push notifications opt-in (US-1901) */}
      <PushNotificationsCard />

      {/* US-2853 / 00669: quiet hours. Directly under the push card because it
          only ever affects push — the in-app row and any email still arrive. */}
      <QuietHoursCard />

      {/* Usage Alerts Section (US-209) */}
      <Card>
        <CardHeader>
          <CardTitle>Usage Alerts</CardTitle>
          <CardDescription>
            Get a heads-up before you hit a plan cap. We'll show a non-blocking
            upgrade tip when any cap (listings, AI actions, included grades,
            marketplaces) reaches the percentages you pick.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Notify me at</p>
            <div className="flex gap-2">
              {[50, 80, 95].map((t) => {
                const active = alertThresholds.includes(t);
                return (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    aria-pressed={active}
                    onClick={() => toggleAlertThreshold(t)}
                  >
                    {t}%
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Defaults to 80%. Each alert fires at most once per cap per month.
              Clear all to keep just the 80% default.
            </p>
          </div>

          <Button onClick={handleSaveAlertThresholds} disabled={savingAlerts}>
            {savingAlerts && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Alert Settings
          </Button>
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="ai" className="space-y-6">
          {/* AI Item Assistant Section */}
          <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Item Assistant
          </CardTitle>
          <CardDescription>
            AI-assisted cataloging for FlipDesk — fills item fields and writes
            listing copy from your descriptions and photos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Usage meter */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">This month's AI usage</span>
              <span className="text-muted-foreground">
                {aiUnlimited
                  ? `${aiUsed} actions used`
                  : `${aiUsed} / ${effectiveAiLimit} actions`}
              </span>
            </div>
            {!aiUnlimited && <Progress value={aiPct} />}
            <p className="text-xs text-muted-foreground">
              Allowance resets on {nextResetLabel()}.
              {aiUnlimited && " Your plan includes unlimited AI actions."}
            </p>
          </div>

          <Separator />

          {/* Enable toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable AI enrichment</p>
              {/* US-2442: this used to name a "listing-copy" button that does
                  not exist on the web. It exists on iOS and the edge route is
                  live, but no web surface has called it for some time — so the
                  sentence was describing a control the reader could not find,
                  which reads as the setting being broken rather than the copy
                  being wrong.
                  Named by what the web ACTUALLY has, and deliberately not
                  exhaustively: the toggle gates every /api/flipdesk/ai/* route
                  server-side (flipdesk-ai.ts checks ai_enrichment_enabled before
                  any of them), so listing an incomplete set of buttons is what
                  made this drift in the first place. Whether the web should
                  regain a listing-copy button is US-2442 AC1 and is a product
                  call, not a copy fix. */}
              <p className="text-xs text-muted-foreground">
                When off, every AI feature is disabled account-wide — AI Fill,
                the composer's rewrite tools, and photo analysis.
              </p>
            </div>
            <Switch aria-label="Enable AI enrichment" checked={aiEnabled} onCheckedChange={setAiEnabled} />
          </div>

          {/* Custom monthly limit */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-limit">Monthly action limit</Label>
            <Input
              id="ai-limit"
              type="number"
              min="0"
              value={aiLimit}
              onChange={(e) => setAiLimit(e.target.value)}
              placeholder={
                planAiLimit < 0
                  ? "Unlimited (plan default)"
                  : `${planAiLimit} (plan default)`
              }
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Optional. Set a lower number to cap your own AI spend. Leave
              blank to use your plan's allowance.
            </p>
          </div>

          <Button onClick={handleSaveAiSettings} disabled={savingAi}>
            {savingAi && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save AI Settings
          </Button>
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="flipdesk" className="space-y-6">
          {/* Onboarding / product tour */}
          <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Product tour
          </CardTitle>
          <CardDescription>
            Replay the welcome walkthrough any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Welcome tour</p>
              <p className="text-xs text-muted-foreground">
                Revisit the quick walkthrough and update what you use
                GradeThread for.
              </p>
            </div>
            <Button variant="outline" onClick={replayWelcomeTour}>
              Replay tour
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* FlipDesk Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-primary" />
            FlipDesk
          </CardTitle>
          <CardDescription>
            Preferences for the FlipDesk reseller workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Setup checklist</p>
              <p className="text-xs text-muted-foreground">
                Bring the setup checklist back, with whatever you have already
                done still ticked off.
              </p>
            </div>
            <Button variant="outline" onClick={replayFlipdeskTour}>
              Show it again
            </Button>
          </div>

          <Separator />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                Share sale outcomes with GradeThread
              </p>
              <p className="text-xs text-muted-foreground">
                When a graded item sells, share the sold price (no buyer
                info) so the AI grading model can learn how grades correlate
                with real resale values. Opt-in, off by default.
              </p>
            </div>
            <Switch
              checked={shareOutcomes}
              onCheckedChange={handleSaveShareOutcomes}
              disabled={savingShareOutcomes}
              aria-label="Share sale outcomes"
            />
          </div>
        </CardContent>
      </Card>

      {/* US-2852 / 00668: how a new listing opens — format, Best Offer, quantity.
          Sits above the ad-rate card because it is the shape of the listing;
          promotion is a decision you make about a listing that already exists. */}
      <ListingDefaultsCard />

      {/* 00432: Promoted Listings default (off by default, opt-in). */}
      <PromotedListingsDefaultCard />

      {/* US-1861: Thrift Radar contribution — its own consent, its own column,
          its own copy. Never fold it into the sale-outcome switch above. */}
      <RadarContributionCard />

        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          {/* Data Export Section */}
          <Card>
        <CardHeader>
          <CardTitle>Data Export</CardTitle>
          <CardDescription>
            Download all of your account data as a ZIP archive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The archive contains all of your account data as JSON — submissions,
            grade reports, inventory, sales, disputes, API-key metadata,
            notifications, workspace memberships and invitations, connected
            marketplaces, payout imports, feedback, and a financial summary, plus
            a README. Image files are not included (a private store); each
            submission lists its image paths. Limited to one export per day.
          </p>
          {exporting && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{exportStage}</span>
                <span>{exportPct}%</span>
              </div>
              <Progress value={exportPct} />
            </div>
          )}
          <Button onClick={handleExportData} disabled={exporting}>
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export My Data
          </Button>
          <p className="text-xs text-muted-foreground">
            See our{" "}
            <Link to="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>{" "}
            for how we handle and retain your data.
          </p>
        </CardContent>
      </Card>

          {/* US-903: formal data-subject requests (tracked compliance queue). */}
          <Card>
            <CardHeader>
              <CardTitle>Formal data requests</CardTitle>
              <CardDescription>
                File a tracked GDPR/CCPA request. We log it, fulfill it, and keep
                a compliance record — distinct from the instant export above.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => handleFileDataRequest("export")}
                disabled={filingRequest !== null}
              >
                {filingRequest === "export" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Request data export
              </Button>
              <Button
                variant="outline"
                onClick={() => handleFileDataRequest("delete")}
                disabled={filingRequest !== null}
              >
                {filingRequest === "delete" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Request data deletion
              </Button>
            </CardContent>
          </Card>

        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          {/* Two-Factor Authentication (US-374) */}
          <MfaCard />

      {/* Password Section - only for email/password users */}
      {!isOAuthUser && (
        <Card>
          <CardHeader>
            <CardTitle>Change Password</CardTitle>
            <CardDescription>
              Update your password to keep your account secure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                placeholder="Enter new password"
                aria-invalid={!!passwordError}
              />
              <p className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                placeholder="Confirm new password"
                aria-invalid={!!passwordError}
                aria-describedby={
                  passwordError ? "password-error" : undefined
                }
              />
              <FieldError id="password-error">{passwordError}</FieldError>
            </div>

            <Button
              onClick={handleChangePassword}
              disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
            >
              {changingPassword && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update Password
            </Button>
          </CardContent>
        </Card>
      )}

          <SignOutAllCard />
        </TabsContent>

        <TabsContent value="storage" className="space-y-6">
          <PhotoArchiveCard />
        </TabsContent>

        <TabsContent value="danger" className="space-y-6">
          <DangerZoneCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// US-375: revoke every session for this account (all devices). The auth
// listener picks up the sign-out and routes the user back to /login.
function SignOutAllCard() {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  async function handleSignOutAll() {
    const ok = await confirm({
      title: "Sign out of all devices?",
      description:
        "This ends every active session, including this one — you'll need to sign in again on each device.",
      confirmLabel: "Sign out everywhere",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await signOutEverywhere();
      toast.success("Signed out of all devices.");
    } catch (err) {
      toastError(err, "Failed to sign out everywhere");
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Sessions</CardTitle>
        <CardDescription>
          Sign out everywhere if you've used a shared device or suspect your
          account was accessed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={handleSignOutAll} disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Sign out of all devices
        </Button>
      </CardContent>
    </Card>
  );
}

function DangerZoneCard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [reauthPassword, setReauthPassword] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Re-auth requirement (US-275, moved server-side by US-2351). Password users
  // must re-enter their password immediately before erasure, so a walk-up
  // attacker on an unlocked session cannot nuke the account. The check itself is
  // now the SERVER's — this field only collects it. It used to be verified here
  // and never sent, which meant the endpoint's real gate was the confirm string
  // alone. Google/OAuth users have no password; for them the active session plus
  // the typed phrase is the gate, and the server exempts them for the same
  // reason (re-running the OAuth dance to delete would be hostile, and they can
  // revoke the app from their Google account separately).
  const isOAuthUser = user?.app_metadata?.provider === "google";

  async function handleDelete() {
    if (confirmText !== DELETE_CONFIRM_PHRASE) return;
    setDeleting(true);
    try {
      // US-2351 AC4: the password now goes to the SERVER, which checks it.
      //
      // This used to call signInWithPassword() here and then POST without it —
      // so the check was a UX courtesy and the endpoint's only real control was
      // the confirm string. Anything holding a session could delete the account
      // by calling the API directly, including an impersonating admin, for whom
      // this dialog never appears at all.
      //
      // The local check is gone rather than kept alongside: two places deciding
      // the same thing is how one of them drifts, and the browser's answer was
      // never the one that mattered. OAuth accounts have no password and send
      // none; the server exempts them for the same reason.
      const res = await fetch(`${edgeApiUrl()}/api/account/delete`, {
        method: "POST",
        headers: await edgeAuthHeaders(),
        body: JSON.stringify({
          confirm: DELETE_CONFIRM_PHRASE,
          ...(isOAuthUser ? {} : { password: reauthPassword }),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to delete account.");
      }
      // Account (and session) are gone — clear local auth and return home.
      await signOut().catch(() => {});
      toast.success("Your account has been permanently deleted.");
      navigate("/");
    } catch (err) {
      toastError(err, "Failed to delete account.");
      setDeleting(false);
    }
  }

  const canDelete =
    confirmText === DELETE_CONFIRM_PHRASE &&
    (isOAuthUser || reauthPassword.length > 0);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Permanently delete your account and all associated data — submissions,
          grades, inventory, photos, and billing profile. This cannot be undone.
          Consider exporting your data first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="delete-confirm">
            Type <span className="font-mono font-semibold">{DELETE_CONFIRM_PHRASE}</span> to confirm
          </Label>
          <Input
            id="delete-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={DELETE_CONFIRM_PHRASE}
            autoComplete="off"
          />
        </div>
        {!isOAuthUser && (
          <div className="space-y-2">
            <Label htmlFor="delete-reauth">Confirm your password</Label>
            <Input
              id="delete-reauth"
              type="password"
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
            />
          </div>
        )}
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={deleting || !canDelete}
        >
          {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Permanently delete my account
        </Button>
        <p className="text-xs text-muted-foreground">
          Deletion is permanent and irreversible. See our{" "}
          <Link to="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>{" "}
          for details on data retention.
        </p>
      </CardContent>
    </Card>
  );
}

function PhotoArchiveCard() {
  const archive = useArchivePhotos();

  async function run() {
    try {
      const r = await archive.mutateAsync();
      const freedMB = (r.freed_bytes / (1024 * 1024)).toFixed(1);
      if (r.archived === 0) {
        toast.info("No photos eligible for archival yet.");
      } else if (r.errors.length === 0) {
        toast.success(
          `Archived ${r.archived} photo${r.archived === 1 ? "" : "s"} · freed ${freedMB} MB.`,
        );
      } else {
        toastWarning(
          r.errors[0],
          `Archived ${r.archived}, ${r.errors.length} failed.`,
          { duration: 14_000 },
        );
      }
    } catch {
      /* surfaced by hook */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-4 w-4" />
          Storage
        </CardTitle>
        <CardDescription>
          Photos for items in a terminal state (sold, shipped, returned,
          completed) older than 30 days can be moved off Supabase to
          cold-storage on Cloudflare R2. Photos stay viewable — the URL
          just points elsewhere.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={run} disabled={archive.isPending}>
          {archive.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          Archive eligible photos
        </Button>
      </CardContent>
    </Card>
  );
}
