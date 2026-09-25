import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { challengeAndVerifyTotp, decideSignInGate } from "@/lib/mfa";
import { edgeFetch } from "@/lib/edge-fetch";
import { signOut } from "@/lib/auth";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// US-3497: the web sign-in step-up. Before this, a seller who turned on 2FA
// signed in on the web with a password alone: GoTrue minted an AAL1 session,
// ProtectedRoute only looked at "is there a session", and the dashboard opened.
// The second factor was asked for nowhere except the admin area (US-270) and a
// workspace whose owner requires it (US-374). A stolen password was enough.
//
// The rule is GoTrue's own: getAuthenticatorAssuranceLevel() reports
// nextLevel = "aal2" exactly when the user has a VERIFIED factor, and
// currentLevel = "aal1" until this session has passed a challenge. That pair is
// the hold. Anything else (no factor, or already AAL2) passes straight through,
// so a user without 2FA sees no new screen and makes no extra request: the AAL
// read is local, from the session the sign-in just returned.
//
// The hold is in place, not a redirect, so the URL the user was heading for
// (including a `?next=` deep link) is still the URL when the code is accepted.
//
// This is the user-facing gate. The edge does not yet refuse AAL1 tokens for
// users with a factor (outside admin and the workspace policy), so a token
// holder who skips the SPA is not stopped here. That server half is its own
// piece of work; this closes the browser sign-in path the story is about.

type GateState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "challenge"; factorId: string }
  | { phase: "error"; message: string };

export function MfaSignInGate({
  sessionKey,
  children,
}: {
  /** Changes whenever the session token changes (sign-in, verify, refresh). */
  sessionKey: string | null;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<GateState>({ phase: "loading" });

  const refresh = useCallback(async () => {
    try {
      const { data: aal, error } = await supabase.auth.mfa
        .getAuthenticatorAssuranceLevel();
      if (error) throw error;
      if (decideSignInGate(aal) === "pass") {
        setState({ phase: "ready" });
        return;
      }
      // Same read as the admin gate (US-3260): the error is not discarded, or
      // a failed lookup would look like "no factor" and let the user through.
      const { data: factors, error: factorsError } = await supabase.auth.mfa
        .listFactors();
      if (factorsError) throw factorsError;
      const totp = factors?.totp?.find((f) => f.status === "verified");
      if (!totp) {
        // nextLevel said aal2, so there is a verified factor, just not a TOTP
        // one the web can challenge. Fail closed rather than open.
        throw new Error(
          "Your account has a second factor this website can't check yet. Contact support to get back in.",
        );
      }
      setState({ phase: "challenge", factorId: totp.id });
    } catch (e) {
      // Fail CLOSED: an unreadable assurance level never opens the dashboard.
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionKey]);

  if (state.phase === "ready") return <>{children}</>;

  if (state.phase === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray p-4 dark:bg-brand-night">
      {state.phase === "challenge" ? (
        <SignInChallenge factorId={state.factorId} onDone={refresh} />
      ) : (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>We couldn't check your sign-in</CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
          <CardFooter className="flex gap-2">
            <Button onClick={() => void refresh()}>Try again</Button>
            <SignOutButton />
          </CardFooter>
        </Card>
      )}
    </div>
  );
}

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut();
        } catch (e) {
          toastError(e, "Couldn't sign out");
        } finally {
          setBusy(false);
        }
      }}
    >
      <LogOut className="mr-2 h-4 w-4" />
      Sign out
    </Button>
  );
}

function SignInChallenge({
  factorId,
  onDone,
}: {
  factorId: string;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function verifyTotp() {
    setBusy(true);
    setErr(null);
    try {
      // Elevates this session to AAL2. onAuthStateChange carries the new token
      // into the store, and onDone re-reads the level to open the gate.
      await challengeAndVerifyTotp(factorId, code);
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitRecoveryCode() {
    setBusy(true);
    setErr(null);
    try {
      // US-374's lost-device path: the edge burns the code with a conditional
      // update (only an UNUSED row for THIS caller), so a second use of the same
      // code is refused, then removes the caller's TOTP factors.
      const res = await edgeFetch("/api/account/mfa/recovery-codes/consume", {
        method: "POST",
        json: { code },
        skipWorkspaceHeader: true,
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(json.error ?? "That recovery code didn't work.");
      }
      // The stored session still lists the factor that was just removed. Pull a
      // fresh one so the assurance level stops asking for it.
      const { error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) throw refreshErr;
      toast.success(
        "Recovery code accepted. Two-factor sign-in is now off. Set it up again in Settings.",
      );
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const isTotp = mode === "totp";
  const ready = isTotp ? code.trim().length >= 6 : code.trim().length >= 8;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck className="h-6 w-6 text-primary" />
        </div>
        <CardTitle>Enter your sign-in code</CardTitle>
        <CardDescription>
          {isTotp
            ? "Your account has two-factor sign-in turned on. Enter the 6-digit code from your authenticator app."
            : "Enter one of the recovery codes you saved when you set up two-factor sign-in. Each code works once."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="signin-mfa-code">
            {isTotp ? "6-digit code" : "Recovery code"}
          </Label>
          <Input
            id="signin-mfa-code"
            inputMode={isTotp ? "numeric" : "text"}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready && !busy) {
                void (isTotp ? verifyTotp() : submitRecoveryCode());
              }
            }}
            placeholder={isTotp ? "123456" : "ABCD-2345"}
          />
        </div>
        {err && (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <Button
          className="w-full"
          disabled={busy || !ready}
          onClick={() => void (isTotp ? verifyTotp() : submitRecoveryCode())}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="mr-2 h-4 w-4" />
          )}
          {isTotp ? "Verify" : "Use recovery code"}
        </Button>
        <Button
          variant="link"
          className="w-full"
          disabled={busy}
          onClick={() => {
            setMode(isTotp ? "recovery" : "totp");
            setCode("");
            setErr(null);
          }}
        >
          {isTotp ? "Lost your device? Use a recovery code" : "Use your authenticator app instead"}
        </Button>
      </CardContent>
      <CardFooter className="justify-center">
        <SignOutButton />
      </CardFooter>
    </Card>
  );
}
