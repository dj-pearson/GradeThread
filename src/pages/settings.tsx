import { useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import type { UserUpdate, NotificationPreferences } from "@/types/database";
import {
  NOTIFICATION_TYPES,
  withPreferenceDefaults,
} from "@/lib/notification-preferences";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  in_app: "In-app",
};

export function SettingsPage() {
  const { user, profile, refreshProfile } = useAuth();

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
    </div>
  );
}
