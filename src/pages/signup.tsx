import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Rocket, Check, Sparkles, Bookmark } from "lucide-react";
import {
  appleOAuthEnabled,
  signUpWithEmail,
  signInWithGoogle,
  signInWithApple,
  resendConfirmationEmail,
} from "@/lib/auth";
import { TurnstileWidget, captchaRequired } from "@/components/auth/turnstile";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import {
  AUTH_NETWORK_ERROR_MESSAGE,
  AUTH_RATE_LIMIT_MESSAGE,
  classifyAuthFailure,
} from "@/lib/auth-error";
import { track } from "@/lib/analytics";
import { trackBuyerFunnel } from "@/lib/buyer-analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordField } from "@/components/auth/password-field";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FieldError } from "@/components/ui/form-feedback";
import { validateEmail, validateRequired } from "@/lib/validation";
import { USE_CASE_OPTIONS } from "@/lib/use-cases";
import { cn } from "@/lib/utils";
import type { UserUseCase, SignupSource } from "@/types/database";
import { SIGNUP_SOURCE_OPTIONS } from "@/lib/constants";
import { claimSummary, readBuyerClaim } from "@/lib/buyer-conversion-claim";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { SEO } from "@/components/seo";

// Mirrors the constant in components/launch-banner.tsx. The signup notice
// auto-hides on/after launch so we don't have to remember to strip it.
const LAUNCH_DATE = new Date("2026-07-01T00:00:00Z");
const PRE_LAUNCH = Date.now() < LAUNCH_DATE.getTime();

// US-2121: the seller signup path enrols the account in a 14-day Pro trial
// server-side (handle_new_user, 00401_buyer_account_roles.sql). ROSCA / the
// state auto-renewal laws require the trial to be disclosed AT the point of
// enrolment — not only in the pricing FAQ or a post-signup banner. Single source
// so the disclosure copy and the analytics event can never drift apart. Buyers
// (`intent=buyer`) get NO trial (free/none), so the disclosure is seller-only.
const TRIAL_DAYS = 14;

export function SignupPage() {
  const [params] = useSearchParams();
  const invitedEmail = params.get("email") ?? "";
  // US-1797: buyer-first signup. `?intent=buyer` reframes the copy and provisions
  // the buyer role (account_type=buyer → handle_new_user, no seller/FlipDesk
  // assumptions). AuthLayout then lands a buyer-only account in /buyer.
  const isBuyer = params.get("intent") === "buyer";
  // US-1843: an estimate parked by a free public tool before this visitor had an
  // account. Shown back to them here so "create an account" reads as keeping the
  // thing they already have, not as starting over. Read once — nothing on this
  // page consumes it; the buyer home is where it's claimed.
  const [pendingClaim] = useState(() => (isBuyer ? readBuyerClaim() : null));
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  // US-1122: persona captured up front so the dashboard personalizes on first
  // paint. Optional here (the post-signup OnboardingFlow still confirms it), but
  // when picked it rides along signup metadata → handle_new_user stamps it.
  const [useCase, setUseCase] = useState<UserUseCase | null>(null);
  // US-1670: self-reported "How did you hear about us?" (esp. the AI-assistant option).
  const [signupSource, setSignupSource] = useState<SignupSource | "">("");
  const [isLoading, setIsLoading] = useState(false);
  // US-1462: which OAuth provider redirect is in flight — disables every auth
  // control and shows a spinner so a slow redirect can't be double-fired.
  const [oauthPending, setOauthPending] = useState<"google" | "apple" | null>(
    null,
  );
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
  // US-1415: resend-confirmation on the "Check your email" screen. With email
  // confirmation on, GoTrue issues no session on signup and blocks sign-in for
  // unconfirmed accounts, so a user who never receives the email is otherwise
  // stuck. Cooldown so a slow inbox doesn't let them hammer GoTrue's rate limit.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

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
      await signUpWithEmail(
        email,
        password,
        fullName,
        captchaToken ?? undefined,
        useCase ?? undefined,
        signupSource || undefined,
        isBuyer ? "buyer" : undefined,
      );
      setIsConfirmation(true);
      // GT-001: the top of the verify funnel. Everything after this point is
      // outside the app, so this count is the denominator the drop-off is
      // measured against.
      track("signup.confirm_sent", { method: "email" });
      if (isBuyer) {
        track("signup.buyer", { at: "signup" });
        // US-1845: the same moment as a funnel STEP, carrying acquisition
        // source, so signup sits on one series with the tool result before it
        // and the subscription after it.
        trackBuyerFunnel("signup", { source: signupSource || undefined });
      }
      if (useCase) track("onboarding.use_case_selected", { use_case: useCase, at: "signup" });
      // US-1670: attribute discovery source (esp. AI assistants) for SEO/GEO.
      if (signupSource) track("signup.source_selected", { source: signupSource });

      // US-219: every new signup is granted a 14-day Pro trial by the
      // handle_new_user trigger. Record the trial start (consent-gated no-op
      // until the visitor opts in). US-2121: disclosed on-screen below.
      track("trial.started", { plan: "pro", trial_days: TRIAL_DAYS });

      // US-1433: the welcome email is no longer fired here. It's now sent from
      // useAuth on the first authenticated session (any signup method, incl.
      // OAuth) via sendWelcomeEmailOnce — which also fixes the wrong-host bug
      // this call had (it POSTed to VITE_SUPABASE_URL, where /api/* 404s).
    } catch (err) {
      // US-369: never reveal whether an email is already registered. GoTrue
      // usually obfuscates this, but if an "already registered" error does
      // surface, show the same neutral confirmation screen instead of leaking
      // account existence. Other errors get a single generic message.
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (msg.includes("registered") || msg.includes("already") || msg.includes("exists")) {
        setIsConfirmation(true);
      } else {
        // US-1432: don't collapse a rate-limit (429, common on the email-send
        // path) or an offline/network failure into "check your details" — show a
        // distinct message for each; only genuine failures get the generic one.
        const kind = classifyAuthFailure(err);
        toast.error(
          kind === "rate_limit"
            ? AUTH_RATE_LIMIT_MESSAGE
            : kind === "network"
              ? AUTH_NETWORK_ERROR_MESSAGE
              : "We couldn't create your account. Please check your details and try again.",
        );
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
    // US-1462 AC3: guard against re-entry while a redirect is already in flight.
    if (oauthPending || isLoading) return;
    setOauthPending("google");
    try {
      await signInWithGoogle();
      // Success navigates to the provider — leave the spinner up.
    } catch (err) {
      toastError(err, "Failed to sign in with Google");
      setOauthPending(null);
    }
  }

  async function handleAppleSignIn() {
    // US-377: same clickwrap gate as Google — OAuth can't carry the checkbox
    // through the redirect, so block here and let the dashboard legal gate do
    // the authoritative server-side capture.
    if (!agreedToLegal) {
      toast.error("Please agree to the Terms of Service and Privacy Policy first.");
      return;
    }
    if (oauthPending || isLoading) return;
    setOauthPending("apple");
    try {
      await signInWithApple();
    } catch (err) {
      toastError(err, "Failed to sign in with Apple");
      setOauthPending(null);
    }
  }

  // US-1415: tick the resend cooldown down to 0.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function handleResend() {
    if (resendBusy || resendCooldown > 0 || !email) return;
    setResendBusy(true);
    try {
      await resendConfirmationEmail(email);
      track("signup.confirm_resend", { at: "signup" });
      // Neutral, enumeration-safe copy: never reveals whether the address is
      // registered/unverified.
      toast.success("If that account needs confirming, we've sent a new link.");
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

  if (isConfirmation) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Check your email</CardTitle>
          <CardDescription>
            We sent a confirmation email to <strong>{email}</strong>. Click the
            link, or enter the 6-digit code, to verify your account.
          </CardDescription>
          {/* GT-001: said here because it is only actionable here. The link
              completes fastest in this browser; someone who reads the mail on
              their phone should type the code instead of clicking. */}
          <CardDescription className="mt-2">
            Opening the email on your phone? Enter the code below rather than
            clicking the link, which finishes fastest in this browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button asChild className="w-full">
            <Link to={`/auth/confirm?email=${encodeURIComponent(email)}`}>
              Enter confirmation code
            </Link>
          </Button>
          <p className="mt-4 text-sm text-muted-foreground">
            Didn't get it? Check your spam folder, or resend it.
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
                : "Resend confirmation email"}
          </Button>
        </CardContent>
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
      {/* US-2529: no title at all, on the page that opens an account — a saved
          tab read "GradeThread" and said nothing about which page it was. */}
      <SEO
        title="Create your account"
        description="Create a free GradeThread account to grade a garment, get a shareable certificate and list it."
      />
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          {isBuyer ? "Shop secondhand with confidence" : "Create an account"}
        </CardTitle>
        <CardDescription>
          {isBuyer
            ? "Create your free buyer account — second-opinion condition checks, alerts, and grade-locked confidence at the point of purchase."
            : "Start grading clothes with AI today"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pendingClaim && (
          <div className="mb-5 flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-sm">
            <Bookmark className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="font-semibold text-brand-navy dark:text-foreground">
                We've kept your estimate
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {claimSummary(pendingClaim)} — it'll be waiting on your buyer home,
                ready to turn into an alert or a closet entry.
              </p>
            </div>
          </div>
        )}
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
        {/* US-2121: disclose the 14-day Pro trial AT the point of enrolment.
            Sits above the form and both OAuth buttons, so it is shown before the
            account is created by ANY method (email or OAuth). Seller-only —
            buyer signups (intent=buyer) are provisioned free/none with no trial,
            so showing trial copy there would be a false disclosure. The
            no-charge outcome is stated positively (features switch to Free),
            per US-2121 AC2. */}
        {!isBuyer && (
          <div className="mb-5 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
            <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-semibold text-brand-navy dark:text-foreground">
                Your account starts with a {TRIAL_DAYS}-day free Pro trial
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                No credit card required. When the {TRIAL_DAYS} days are up, your
                account simply switches to the free plan — you're never charged
                unless you choose to add a card and upgrade to Pro.
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
            <PasswordField
              id="password"
              showStrength
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
          {/* US-1670: self-reported discovery source. Optional — the "AI
              assistant" option is the only reliable ChatGPT/Claude/Perplexity
              attribution (referrers are stripped). */}
          <div className="space-y-2">
            <Label htmlFor="signup-source">
              How did you hear about us?{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <select
              id="signup-source"
              value={signupSource}
              onChange={(e) => setSignupSource(e.target.value as SignupSource | "")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Select…</option>
              {SIGNUP_SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <TurnstileWidget
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            resetSignal={captchaReset}
          />
          {/* US-377: affirmative clickwrap — gates the submit button below. The
              age affirmation rides on the same checkbox so an under-18 account
              can't be created without a separate birthdate gate. 18 matches the
              eligibility floor in Terms §1 (paid contracts + reselling); it also
              keeps us clear of GDPR Art. 8 child-consent and COPPA entirely. */}
          <label htmlFor="legal-consent" className="flex items-start gap-2.5 text-xs text-muted-foreground">
            <input
              id="legal-consent"
              type="checkbox"
              checked={agreedToLegal}
              onChange={(e) => setAgreedToLegal(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-brand-red"
            />
            <span>
              I confirm I'm at least 18 years old, and I agree to the{" "}
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
            disabled={isLoading || !agreedToLegal || oauthPending !== null}
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
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
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
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-red-text hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
