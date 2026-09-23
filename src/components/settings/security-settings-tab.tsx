import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/form-feedback";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { signOutEverywhere, signOutOtherSessions } from "@/lib/auth";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { toastError } from "@/lib/toast-error";
import { MfaCard } from "@/components/settings/mfa-card";

// The Security tab of /dashboard/settings: two-factor, password, sessions.
// Split out of settings.tsx (web-growth action 6).
export function SecuritySettingsTab() {
  const { user } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const isOAuthUser = user?.app_metadata?.provider === "google";

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

  return (
    <>
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
                autoComplete="current-password"
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
                autoComplete="new-password"
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
                autoComplete="new-password"
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
    </>
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
