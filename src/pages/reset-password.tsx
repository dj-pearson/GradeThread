import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword, updatePassword } from "@/lib/auth";
import { TurnstileWidget, captchaRequired } from "@/components/auth/turnstile";
import { supabase } from "@/lib/supabase";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

// How long to wait for a recovery session (getSession or PASSWORD_RECOVERY)
// before declaring the reset link expired. Generous so a slow network doesn't
// misreport a valid link as expired (US-798).
const RECOVERY_SESSION_TIMEOUT_MS = 10_000;

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const hasToken = searchParams.has("token") || searchParams.has("code");

  if (hasToken) {
    return <UpdatePasswordForm />;
  }

  return <RequestResetForm />;
}

function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSent, setIsSent] = useState(false);
  // US-368: Turnstile token + a counter to reset the (single-use) widget on retry.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (captchaRequired && !captchaToken) {
      toast.error("Please complete the verification challenge.");
      return;
    }
    setIsLoading(true);
    try {
      await resetPassword(email, captchaToken ?? undefined);
      setIsSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reset email");
      // US-368: the Turnstile token was consumed — reset for the retry.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setIsLoading(false);
    }
  }

  if (isSent) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a password reset link to <strong>{email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Link to="/login" className="text-sm text-brand-red hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Reset password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <TurnstileWidget
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            resetSignal={captchaReset}
          />
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center">
        <Link to="/login" className="text-sm text-muted-foreground hover:underline">
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}

function UpdatePasswordForm() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // US-371: only allow the update once we've confirmed a recovery session
  // exists. A valid reset link establishes one (detectSessionInUrl) and fires
  // PASSWORD_RECOVERY; without it the link is invalid/expired.
  const [phase, setPhase] = useState<"checking" | "ready" | "expired">("checking");

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) setPhase("ready");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setPhase("ready");
      }
    });
    // If no recovery session has materialized within this window, the link is
    // bad or expired — stop showing the form. 10s (not 4s) so a slow network or
    // a delayed PASSWORD_RECOVERY event isn't misreported as expired (US-798).
    const timer = window.setTimeout(() => {
      setPhase((p) => (p === "checking" ? "expired" : p));
    }, RECOVERY_SESSION_TIMEOUT_MS);
    return () => {
      active = false;
      sub.subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase !== "ready") return;
    const check = checkPassword(password);
    if (!check.ok) {
      toast.error(check.reason ?? "Password does not meet the requirements");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setIsLoading(true);
    try {
      await updatePassword(password);
      // US-371: revoke ALL sessions after a password change so a previously
      // stolen/active session can't survive the reset. The user re-authenticates
      // with the new password.
      await supabase.auth.signOut({ scope: "global" }).catch(() => {});
      toast.success("Password updated. Please sign in with your new password.");
      navigate("/login", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setIsLoading(false);
    }
  }

  if (phase === "checking") {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Set new password</CardTitle>
          <CardDescription>Verifying your reset link…</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </CardContent>
      </Card>
    );
  }

  if (phase === "expired") {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Reset link invalid or expired</CardTitle>
          <CardDescription>
            This password reset link is no longer valid. Request a new one to try
            again.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center gap-4">
          <Link to="/auth/reset-password" className="text-sm text-brand-red hover:underline">
            Request a new link
          </Link>
          <Link to="/login" className="text-sm text-muted-foreground hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Set new password</CardTitle>
        <CardDescription>Enter your new password below.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              placeholder={PASSWORD_HINT}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={10}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={10}
            />
          </div>
          <p className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Updating..." : "Update password"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center">
        <Link to="/login" className="text-sm text-muted-foreground hover:underline">
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
