import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
import type { UserUpdate, NotificationPreferences } from "@/types/database";
import {
  NOTIFICATION_TYPES,
  withPreferenceDefaults,
} from "@/lib/notification-preferences";
import { buildAccountExport } from "@/lib/account-export";
import { PLANS, type PlanKey } from "@/lib/constants";
import { Loader2, Upload, Download, Sparkles, Compass, Archive } from "lucide-react";
import { toast } from "sonner";
import { useFlipdeskTourStore } from "@/stores/flipdesk-tour-store";
import { useArchivePhotos } from "@/hooks/use-image-archive";

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

  const planKey = (profile?.plan ?? "free") as PlanKey;
  const planAiLimit = PLANS[planKey].aiActionsPerMonth;
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

        const { error: uploadError } = await supabase.storage
          .from("submission-images")
          .upload(path, avatarFile, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from("submission-images")
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
    if (!newPassword || !confirmPassword) {
      toast.error("Please fill in all password fields");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }

    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setChangingPassword(true);

    try {
      // Verify current password by re-authenticating
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

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated successfully");
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

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gradethread-export-${
        new Date().toISOString().split("T")[0]
      }.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

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
            The archive contains your submissions, grade reports, inventory,
            sales, and a financial summary as JSON files. Image URLs are
            included; image files are not, to keep the download small.
            Limited to one export per day.
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
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
              />
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
    </div>
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
