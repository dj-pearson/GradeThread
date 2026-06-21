import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Rocket, Check } from "lucide-react";
import * as Sentry from "@sentry/react";
import { signUpWithEmail, signInWithGoogle } from "@/lib/auth";
import { TurnstileWidget, captchaRequired } from "@/components/auth/turnstile";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FieldError } from "@/components/ui/form-feedback";
import { validateEmail, validateRequired } from "@/lib/validation";
import { USE_CASE_OPTIONS } from "@/lib/use-cases";
import { cn } from "@/lib/utils";
import type { UserUseCase } from "@/types/database";
import { toast } from "sonner";

// Mirrors the constant in components/launch-banner.tsx. The signup notice
// auto-hides on/after launch so we don't have to remember to strip it.
const LAUNCH_DATE = new Date("2026-07-01T00:00:00Z");
const PRE_LAUNCH = Date.now() < LAUNCH_DATE.getTime();

const EDGE_URL = import.meta.env.VITE_SUPABASE_URL
  ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, "")}`
  : "";

export function SignupPage() {
  const [params] = useSearchParams();
  const invitedEmail = params.get("email") ?? "";
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  // US-1122: persona captured up front so the dashboard personalizes on first
  // paint. Optional here (the post-signup OnboardingFlow still confirms it), but
  // when picked it rides along signup metadata → handle_new_user stamps it.
  const [useCase, setUseCase] = useState<UserUseCase | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmation, setIsConfirmation] = useState(false);
  // US-444: inline, screen-reader-associated field errors that persist until
  // corrected, replacing the password/required toasts below.
  const [errors, setErrors] = useState<{
    fullName?: string;
    email?: string;
    password?: string;
  }>({});
  // US-377: affirmative ToS/Privacy clickwrap. Must be checked before any
  // account is created (email OR Google). The accepted version + timestamp are
  // recorded server-side (email: signup metadata → handle_new_user; OAuth: the
  // dashboard legal gate captures it before first access).
  const [agreedToLegal, setAgreedToLegal] = useState(false);
  // US-368: Turnstile token + a counter to reset the (single-use) widget on retry.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // US-444: validate each field inline. US-367: the password check is the
    // client mirror of the server policy (server is authoritative). Errors
    // render at the field and focus moves to the first invalid one.
    const pwCheck = checkPassword(password);
    const nextErrors = {
      fullName: validateRequired(fullName, "Full name"),
      email: validateEmail(email),
      password: pwCheck.ok
        ? undefined
        : pwCheck.reason ?? "Password does not meet the requirements",
    };
    setErrors(nextErrors);
    if (nextErrors.fullName || nextErrors.email || nextErrors.password) {
      const firstId = nextErrors.fullName
        ? "name"
        : nextErrors.email
          ? "email"
          : "password";
      document.getElementById(firstId)?.focus();
      return;
    }
    // US-368: bot-protection — a captcha token is required when Turnstile is on.
    if (captchaRequired && !captchaToken) {
      toast.error("Please complete the verification challenge.");
      return;
    }
    // US-377: clickwrap — affirmative consent is mandatory.
    if (!agreedToLegal) {
      toast.error("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }
    setIsLoading(true);
    try {
      const data = await signUpWithEmail(
        email,
        password,
        fullName,
        captchaToken ?? undefined,
        useCase ?? undefined,
      );
      setIsConfirmation(true);
      if (useCase) track("onboarding.use_case_selected", { use_case: useCase, at: "signup" });

      // US-219: every new signup is granted a 14-day Pro trial by the
      // handle_new_user trigger. Record the trial start (consent-gated no-op
      // until the visitor opts in).
      track("trial.started", { plan: "pro", trial_days: 14 });

      // Send welcome email (fire-and-forget, non-blocking). US-785: a failure is
      // no longer SILENT — capture it to Sentry so a broken welcome pipeline is
      // visible, without ever blocking signup.
      if (data?.user?.id && EDGE_URL) {
        fetch(`${EDGE_URL}/api/notifications/welcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: data.user.id }),
        })
          .then((res) => {
            if (!res.ok) {
              Sentry.captureMessage("signup welcome email request failed", {
                level: "warning",
                extra: { status: res.status },
              });
            }
          })
          .catch((e) => {
            Sentry.captureException(e, { tags: { area: "signup.welcome_email" } });
          });
      }
    } catch (err) {
      // US-369: never reveal whether an email is already registered. GoTrue
      // usually obfuscates this, but if an "already registered" error does
      // surface, show the same neutral confirmation screen instead of leaking
      // account existence. Other errors get a single generic message.
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("registered") || msg.includes("already") || msg.includes("exists")) {
        setIsConfirmation(true);
      } else {
        toast.error("We couldn't create your account. Please check your details and try again.");
        // US-368: the Turnstile token was consumed — reset for the retry.
        setCaptchaToken(null);
        setCaptchaReset((n) => n + 1);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    // US-377: require the clickwrap before redirecting to Google too. OAuth
    // can't carry the checkbox through the redirect, so the dashboard legal gate
    // is the authoritative server-side capture — but we still block here so the
    // intent is explicit and the gate is a fallback, not the only consent point.
    if (!agreedToLegal) {
      toast.error("Please agree to the Terms of Service and Privacy Policy first.");
      return;
    }
    try {
      await signInWithGoogle();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign in with Google");
    }
  }

  if (isConfirmation) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Check your email</CardTitle>
          <CardDescription>
            We sent a confirmation link to <strong>{email}</strong>. Click the
            link to verify your account.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Link to="/login" className="text-sm text-brand-red-text hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Create an account</CardTitle>
        <CardDescription>Start grading clothes with AI today</CardDescription>
      </CardHeader>
      <CardContent>
        {PRE_LAUNCH && (
          <div className="mb-5 flex items-start gap-3 rounded-md border border-brand-red/30 bg-brand-red/5 p-3 text-sm">
            <Rocket className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-red-text" />
            <div>
              <p className="font-semibold text-brand-navy dark:text-foreground">
                GradeThread launches July 1, 2026.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create your account now to be ready on day one. AI grading and
                FlipDesk go live July 1 — your profile, preferences, and
                onboarding will be waiting for you.
              </p>
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              placeholder="Jane Smith"
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                if (errors.fullName) setErrors((prev) => ({ ...prev, fullName: undefined }));
              }}
              required
              aria-invalid={!!errors.fullName}
              aria-describedby={errors.fullName ? "name-error" : undefined}
            />
            <FieldError id="name-error">{errors.fullName}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
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
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder={PASSWORD_HINT}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
              }}
              required
              minLength={10}
              aria-invalid={!!errors.password}
              aria-describedby={
                errors.password ? "password-error" : "password-hint"
              }
            />
            <FieldError id="password-error">{errors.password}</FieldError>
            <p id="password-hint" className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
          </div>
          {/* US-1122: capture the persona up front so the dashboard tailors its
              first paint. Optional — skipping it just defers capture to the
              post-signup onboarding flow. */}
          <div className="space-y-2">
            <Label>What brings you here? <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <div className="grid grid-cols-2 gap-2">
              {USE_CASE_OPTIONS.map((option) => {
                const selected = useCase === option.value;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setUseCase((prev) => (prev === option.value ? null : option.value))}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border-2 p-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
                    <span className="flex-1 font-medium">{option.label}</span>
                    {selected && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>
          <TurnstileWidget
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            resetSignal={captchaReset}
          />
          {/* US-377: affirmative clickwrap — gates the submit button below. */}
          <label htmlFor="legal-consent" className="flex items-start gap-2.5 text-xs text-muted-foreground">
            <input
              id="legal-consent"
              type="checkbox"
              checked={agreedToLegal}
              onChange={(e) => setAgreedToLegal(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-brand-red"
            />
            <span>
              I agree to the{" "}
              <Link to="/terms" target="_blank" className="underline hover:text-foreground">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link to="/privacy" target="_blank" className="underline hover:text-foreground">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || !agreedToLegal}
          >
            {isLoading ? "Creating account..." : "Create account"}
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
        >
          <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </Button>
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-red-text hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
