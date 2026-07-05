import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  resendConfirmationEmail,
  verifyEmailCode,
  verifyEmailTokenHash,
} from "@/lib/auth";
import { PENDING_INVITE_KEY } from "@/pages/accept-invite";
import { RETURN_TO_KEY, sanitizeReturnTo } from "@/lib/return-to";
import { stripSensitiveParams } from "@/lib/redact-url";
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
import { FieldError } from "@/components/ui/form-feedback";
import { toast } from "sonner";

// This page lives OUTSIDE AuthLayout (so our post-verify navigation isn't
// pre-empted by AuthLayout's hard redirect once the session forms), so it
// supplies AuthLayout's centering container + logo itself.
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <img src="/logo_primary.png" alt="GradeThread" className="h-10" />
        </div>
        {children}
      </div>
    </div>
  );
}

// Email verification screen. Reached two ways from the branded auth email:
//   1. The confirm LINK → lands here with ?token_hash=…&type=… → auto-verify.
//   2. The 6-digit CODE → the user types it here (link fallback).
// On success a session exists and we route the user on exactly like the OAuth
// callback (pending invite → returnTo → /dashboard), honoring the email's
// redirect_to when it's an internal path.
export function AuthConfirmPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const redirectTo = params.get("redirect_to");
  const emailParam = params.get("email") ?? "";

  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"verifying" | "form" | "submitting">(
    tokenHash ? "verifying" : "form",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // US-1635: scrub the single-use token_hash from the visible URL once React has
  // read it (above). React Router keeps its own copy in searchParams, so verify
  // still works; this just stops the token lingering in history / the Referer
  // header / a later SPA pageview. Runs once on mount.
  useEffect(() => {
    const { url, changed } = stripSensitiveParams(window.location.href);
    if (changed) window.history.replaceState(window.history.state, "", url);
  }, []);

  const goAfterVerify = useCallback(() => {
    // Same precedence as auth-callback: finish a pending workspace invite, then
    // an internal returnTo (from the email's redirect_to or a stashed deep link),
    // else the dashboard.
    const pendingToken = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (pendingToken) {
      navigate(`/accept-invite?token=${pendingToken}`, { replace: true });
      return;
    }
    const stashed = sanitizeReturnTo(sessionStorage.getItem(RETURN_TO_KEY));
    sessionStorage.removeItem(RETURN_TO_KEY);
    const fromEmail = sanitizeReturnTo(redirectTo);
    navigate(stashed ?? fromEmail ?? "/dashboard", { replace: true });
  }, [navigate, redirectTo]);

  // 1. Auto-verify a clicked link (token_hash in the URL). Runs once.
  const ranLink = useRef(false);
  useEffect(() => {
    if (!tokenHash || ranLink.current) return;
    ranLink.current = true;
    void (async () => {
      try {
        await verifyEmailTokenHash(tokenHash, type);
        goAfterVerify();
      } catch {
        // The link is invalid/expired — fall back to manual code entry.
        setPhase("form");
        setErrorMessage(
          "That confirmation link is invalid or has expired. Enter the code from your email, or request a new one.",
        );
      }
    })();
  }, [tokenHash, type, goAfterVerify]);

  // Tick the resend cooldown down.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    const trimmedCode = code.replace(/\s+/g, "");
    if (!email) {
      setErrorMessage("Enter the email address you signed up with.");
      document.getElementById("confirm-email")?.focus();
      return;
    }
    if (trimmedCode.length < 6) {
      setErrorMessage("Enter the 6-digit code from your email.");
      document.getElementById("confirm-code")?.focus();
      return;
    }
    setPhase("submitting");
    try {
      await verifyEmailCode(email, trimmedCode, type);
      goAfterVerify();
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      setErrorMessage(
        msg.includes("expired")
          ? "That code has expired. Request a new one below."
          : "That code is incorrect or expired. Double-check it, or request a new one.",
      );
      setPhase("form");
    }
  }

  async function handleResend() {
    if (resendBusy || resendCooldown > 0 || !email) return;
    setResendBusy(true);
    try {
      await resendConfirmationEmail(email);
      toast.success("If that account needs confirming, we've sent a new code.");
      setResendCooldown(45);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("rate") || msg.includes("429") || msg.includes("too many")) {
        toast.error("Too many requests — please wait a moment and try again.");
        setResendCooldown(45);
      } else {
        toast.error("We couldn't resend the email. Please try again shortly.");
      }
    } finally {
      setResendBusy(false);
    }
  }

  if (phase === "verifying") {
    return (
      <AuthShell>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Confirming your email…</CardTitle>
            <CardDescription>This only takes a moment.</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center py-6">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </CardContent>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Confirm your email</CardTitle>
        <CardDescription>
          Enter the 6-digit code we emailed you to verify your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!emailParam && (
            <div className="space-y-2">
              <Label htmlFor="confirm-email">Email</Label>
              <Input
                id="confirm-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="confirm-code">Verification code</Label>
            <Input
              id="confirm-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/[^0-9]/g, ""));
                if (errorMessage) setErrorMessage(null);
              }}
              className="text-center text-lg tracking-[0.4em]"
              required
            />
            <FieldError id="confirm-code-error">{errorMessage ?? undefined}</FieldError>
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={phase === "submitting"}
          >
            {phase === "submitting" ? "Verifying…" : "Verify email"}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <p className="text-sm text-muted-foreground">
            Didn't get a code? Check your spam folder, or resend it.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            disabled={resendBusy || resendCooldown > 0 || !email}
            onClick={handleResend}
          >
            {resendBusy
              ? "Sending…"
              : resendCooldown > 0
                ? `Resend in ${resendCooldown}s`
                : "Resend code"}
          </Button>
        </div>
      </CardContent>
      <CardFooter className="justify-center">
        <Link to="/login" className="text-sm text-brand-red-text hover:underline">
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
    </AuthShell>
  );
}
