import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  appleOAuthEnabled,
  signInWithApple,
  signInWithEmail,
  signInWithGoogle,
} from "@/lib/auth";
import { SIGN_IN_FAILED_MESSAGE } from "@/lib/auth-identity";
import {
  AUTH_NETWORK_ERROR_MESSAGE,
  AUTH_RATE_LIMIT_MESSAGE,
  classifyAuthFailure,
} from "@/lib/auth-error";
import { RETURN_TO_KEY, sanitizeReturnTo } from "@/lib/return-to";
import { TurnstileWidget, captchaRequired } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordField } from "@/components/auth/password-field";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { setKeepSignedIn } from "@/lib/supabase";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FieldError } from "@/components/ui/form-feedback";
import { validateEmail } from "@/lib/validation";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { SEO } from "@/components/seo";

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteToken = params.get("invite");
  // US-1430: the validated deep-link to return to after sign-in (?next=),
  // falling back to /dashboard. Invite flow keeps its own special-case below.
  const returnTo = sanitizeReturnTo(params.get("next"));
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // US-2530: the last sign-in failure, shown on the form until the next
  // attempt. A toast is gone in four seconds — exactly when someone has looked
  // away to open their password manager.
  const [signInError, setSignInError] = useState<string | null>(null);
  // US-1462: which OAuth provider redirect is in flight (if any) — disables every
  // auth control and shows a spinner so a slow redirect can't be double-fired.
  const [oauthPending, setOauthPending] = useState<"google" | "apple" | null>(
    null,
  );
  // US-444: inline, screen-reader-associated field errors that persist until
  // the field is corrected (not a transient toast).
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  // US-368: Turnstile token + a counter to reset the (single-use) widget on retry.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  // US-1460: default true = prior behavior (persist to localStorage). Unchecking
  // it scopes this session to sessionStorage so it's dropped when the browser
  // closes — for shared/public devices.
  const [keepSignedIn, setKeepSignedInState] = useState(true);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSignInError(null);
    // US-444: validate at the field level first; show inline errors and move
    // focus to the first invalid field rather than firing a toast.
    const nextErrors = {
      email: validateEmail(email),
      password: password ? undefined : "Password is required",
    };
    setErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) {
      document.getElementById(nextErrors.email ? "email" : "password")?.focus();
      return;
    }
    if (captchaRequired && !captchaToken) {
      toast.error("Please complete the verification challenge.");
      return;
    }
    setIsLoading(true);
    try {
      // US-1460: apply the persistence choice before the session is written.
      setKeepSignedIn(keepSignedIn);
      await signInWithEmail(email, password, captchaToken ?? undefined);
      navigate(
        inviteToken
          ? `/accept-invite?token=${inviteToken}`
          : returnTo ?? "/dashboard",
      );
    } catch (err) {
      // US-1432: a rate-limit (429) or an offline/network failure is NOT a
      // credential problem — telling the user to check their password would
      // mislead them. Show a distinct (still enumeration-safe) message for each;
      // only genuine 400/401 failures fall through to the generic credential
      // message below.
      // US-369: that generic message is identical for invalid password / unknown
      // email / unconfirmed email so the text can't be used to enumerate
      // accounts. US-380: it also nudges users who originally signed up a
      // different way (e.g. Google) — an enumeration-safe hint on every failure.
      const kind = classifyAuthFailure(err);
      const message = kind === "rate_limit"
        ? AUTH_RATE_LIMIT_MESSAGE
        : kind === "network"
          ? AUTH_NETWORK_ERROR_MESSAGE
          : SIGN_IN_FAILED_MESSAGE;
      // US-2530: a toast is gone in four seconds, and a failed sign-in is
      // exactly the moment someone looks away to check their password manager.
      // It stays on the form until the next attempt, which is what iOS
      // (LoginView.swift) has always done.
      setSignInError(message);
      toast.error(message);
      // US-368: the Turnstile token was consumed by the failed attempt — reset
      // for the retry.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setIsLoading(false);
    }
  }

  // US-1430: the OAuth round-trip drops the URL's `?next=`, so persist the
  // validated return-to in sessionStorage for the callback to pick up (clear it
  // when there's none so a stale value from an earlier attempt can't leak in).
  function rememberReturnTo() {
    if (returnTo) sessionStorage.setItem(RETURN_TO_KEY, returnTo);
    else sessionStorage.removeItem(RETURN_TO_KEY);
  }

  async function handleGoogleSignIn() {
    // US-1462 AC3: guard against re-entry while a redirect is already in flight.
    if (oauthPending || isLoading) return;
    setOauthPending("google");
    try {
      setKeepSignedIn(keepSignedIn); // US-1460
      rememberReturnTo();
      await signInWithGoogle();
      // On success the browser navigates to the provider — leave the spinner up.
    } catch (err) {
      toastError(err, "Failed to sign in with Google");
      setOauthPending(null);
    }
  }

  async function handleAppleSignIn() {
    if (oauthPending || isLoading) return;
    setOauthPending("apple");
    try {
      setKeepSignedIn(keepSignedIn); // US-1460
      rememberReturnTo();
      await signInWithApple();
    } catch (err) {
      toastError(err, "Failed to sign in with Apple");
      setOauthPending(null);
    }
  }

  return (
    <Card>
      {/* US-2529: this page had no title at all, so a saved tab read
          "GradeThread" and told the visitor nothing about which page it was. */}
      <SEO
        title="Sign in"
        description="Sign in to GradeThread to grade garments, manage your inventory and publish listings."
      />
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your GradeThread account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {signInError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {signInError}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
              }}
              required
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
            />
            <FieldError id="email-error">{errors.email}</FieldError>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                to="/auth/reset-password"
                className="text-xs text-brand-red-text hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <PasswordField
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
              }}
              required
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
            <FieldError id="password-error">{errors.password}</FieldError>
          </div>
          {/* US-1460: opt out of persistent sign-in on a shared/public device. */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="keep-signed-in"
              checked={keepSignedIn}
              onCheckedChange={(v) => setKeepSignedInState(v === true)}
              disabled={isLoading || oauthPending !== null}
            />
            <Label
              htmlFor="keep-signed-in"
              className="text-sm font-normal text-muted-foreground"
            >
              Keep me signed in{" "}
              <span className="text-xs">(uncheck on a shared device)</span>
            </Label>
          </div>
          <TurnstileWidget
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            resetSignal={captchaReset}
          />
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || oauthPending !== null}
          >
            {isLoading ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        <div className="my-4 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <Separator className="flex-1" />
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={handleGoogleSignIn}
          disabled={isLoading || oauthPending !== null}
        >
          {oauthPending === "google" ? (
            <>
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Redirecting…
            </>
          ) : (
            <>
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Continue with Google
            </>
          )}
        </Button>

        {appleOAuthEnabled && (
          <Button
            variant="outline"
            className="mt-3 w-full"
            onClick={handleAppleSignIn}
            disabled={isLoading || oauthPending !== null}
          >
            {oauthPending === "apple" ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Redirecting…
              </>
            ) : (
              <>
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17.05 12.04c-.03-2.6 2.13-3.85 2.22-3.91-1.21-1.77-3.1-2.01-3.77-2.04-1.6-.16-3.13.94-3.94.94-.81 0-2.07-.92-3.4-.9-1.75.03-3.36 1.02-4.26 2.58-1.82 3.16-.47 7.83 1.3 10.39.86 1.25 1.89 2.66 3.24 2.61 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.29-1.28 3.15-2.54.99-1.46 1.4-2.87 1.42-2.94-.03-.01-2.72-1.04-2.75-4.13-.03-2.58 2.11-3.81 2.21-3.88zM14.5 4.41c.72-.87 1.2-2.08 1.07-3.29-1.03.04-2.28.69-3.02 1.56-.66.77-1.24 2-1.09 3.18 1.15.09 2.32-.58 3.04-1.45z"/>
                </svg>
                Continue with Apple
              </>
            )}
          </Button>
        )}
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link to="/signup" className="font-medium text-brand-red-text hover:underline">
            Sign up
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
