import { useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { UserUpdate, NotificationPreferences } from "@/types/database";
import {
  NOTIFICATION_TYPES,
  withPreferenceDefaults,
} from "@/lib/notification-preferences";
import { buildAccountExport } from "@/lib/account-export";
import { FLIPDESK_PLANS, PLANS, type PlanKey } from "@/lib/constants";
import { Loader2, Upload, Download, Sparkles, Compass, Archive, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useFlipdeskTourStore } from "@/stores/flipdesk-tour-store";
import { useArchivePhotos } from "@/hooks/use-image-archive";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders, edgeFetch } from "@/lib/edge-fetch";
import { signOut, signOutEverywhere, signOutOtherSessions } from "@/lib/auth";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { FieldError } from "@/components/ui/form-feedback";

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
};

export function SettingsPage() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const openFlipdeskTour = useFlipdeskTourStore((s) => s.open);

  function replayFlipdeskTour() {
    openFlipdeskTour();
    navigate("/dashboard/flipdesk");
  }

  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  // PLANS shim for users that haven't been backfilled yet — the shim derives
  // the same numbers from FLIPDESK_PLANS so values match.
  const flipdeskPlan = profile?.flipdesk_plan ?? null;
  const planAiLimit = flipdeskPlan
    ? FLIPDESK_PLANS[flipdeskPlan].aiActionsPerMonth
    : PLANS[(profile?.plan ?? "free") as PlanKey].aiActionsPerMonth;
  const effectiveAiLimit = profile?.ai_action_limit ?? planAiLimit;
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
      toast.error(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setSaving(false);
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
      toast.error(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setChangingPassword(false);
    }
  }

  function setChannel(
    typeKey: keyof NotificationPreferences,
    channel: "email" | "in_app",
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
      toast.error(
        err instanceof Error ? err.message : "Failed to save preferences"
      );
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
      toast.error(
        err instanceof Error ? err.message : "Failed to save usage alert settings."
      );
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
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to update sale-outcome sharing."
      );
    } finally {
      setSavingShareOutcomes(false);
    }
  }

  async function handleSaveAiSettings() {
    if (!user) return;
    setSavingAi(true);
    try {
      const trimmed = aiLimit.trim();
      const limitVal =
        trimmed === ""
          ? null
          : Math.max(0, Number.parseInt(trimmed, 10) || 0);
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
      toast.error(
        err instanceof Error ? err.message : "Failed to save AI settings."
      );
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
      toast.error(
        err instanceof Error ? err.message : "Failed to export data."
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account settings.</p>
      </div>

      {/* Profile Section */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
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

      {/* Notification Preferences Section */}
      <Card>
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
                    const checked = (
                      prefs[type.key] as Record<string, boolean>
                    )[channel];
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
              <p className="text-xs text-muted-foreground">
                When off, AI Fill and listing-copy buttons are disabled
                account-wide.
              </p>
            </div>
            <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
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
              <p className="text-sm font-medium">Getting-started tour</p>
              <p className="text-xs text-muted-foreground">
                Replay the FlipDesk onboarding checklist from the start.
              </p>
            </div>
            <Button variant="outline" onClick={replayFlipdeskTour}>
              Replay tour
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

      <PhotoArchiveCard />

      <SignOutAllCard />

      <DangerZoneCard />
    </div>
  );
}

// US-375: revoke every session for this account (all devices). The auth
// listener picks up the sign-out and routes the user back to /login.
function SignOutAllCard() {
  const [busy, setBusy] = useState(false);

  async function handleSignOutAll() {
    setBusy(true);
    try {
      await signOutEverywhere();
      toast.success("Signed out of all devices.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign out everywhere");
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

  // Re-auth requirement (US-275). Password users must re-enter their password
  // immediately before erasure; we verify it client-side via a fresh
  // signInWithPassword so a walk-up attacker on an unlocked session can't nuke
  // the account. Google/OAuth users have no password — for them the active
  // session plus the typed confirmation phrase is the gate (re-running the
  // OAuth dance just to delete would be hostile, and they can revoke our app
  // from their Google account separately).
  const isOAuthUser = user?.app_metadata?.provider === "google";

  async function handleDelete() {
    if (confirmText !== DELETE_CONFIRM_PHRASE) return;
    setDeleting(true);
    try {
      // Step-up re-authentication for password accounts.
      if (!isOAuthUser) {
        const email = user?.email;
        if (!email) {
          throw new Error("Could not verify your identity. Please sign in again.");
        }
        const { error: reauthError } = await supabase.auth.signInWithPassword({
          email,
          password: reauthPassword,
        });
        if (reauthError) {
          throw new Error("Incorrect password. Please re-enter it to confirm.");
        }
      }

      const res = await fetch(`${edgeApiUrl()}/api/account/delete`, {
        method: "POST",
        headers: await edgeAuthHeaders(),
        body: JSON.stringify({ confirm: DELETE_CONFIRM_PHRASE }),
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
      toast.error(err instanceof Error ? err.message : "Failed to delete account.");
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
        toast.warning(
          `Archived ${r.archived}, ${r.errors.length} failed. First: ${r.errors[0]?.message}`,
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
