import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";
import { hasPasswordIdentity, oauthProviderLabel, signOut } from "@/lib/auth";
import { toastError } from "@/lib/toast-error";

const DELETE_CONFIRM_PHRASE = "DELETE MY ACCOUNT";

export function DangerZoneCard() {
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
  // hasPasswordIdentity mirrors the server's rule exactly (any "email" identity
  // means a password exists), so a Google-first account that later added a
  // password is asked for it, and an Apple-only account is not.
  const isOAuthUser = !hasPasswordIdentity(user);

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
        {isOAuthUser && (
          <p className="text-sm text-muted-foreground">
            You sign in with {oauthProviderLabel(user)}, so no password is needed.
            Typing the phrase above is enough.
          </p>
        )}
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
