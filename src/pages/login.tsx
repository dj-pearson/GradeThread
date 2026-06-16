import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { signInWithEmail, signInWithGoogle } from "@/lib/auth";
import { SIGN_IN_FAILED_MESSAGE } from "@/lib/auth-identity";
import { TurnstileWidget, captchaRequired } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FieldError } from "@/components/ui/form-feedback";
import { validateEmail } from "@/lib/validation";
import { toast } from "sonner";

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const inviteToken = params.get("invite");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // US-444: inline, screen-reader-associated field errors that persist until
  // the field is corrected (not a transient toast).
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  // US-368: Turnstile token + a counter to reset the (single-use) widget on retry.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
      await signInWithEmail(email, password, captchaToken ?? undefined);
      navigate(inviteToken ? `/accept-invite?token=${inviteToken}` : "/dashboard");
    } catch {
      // US-369: a single generic message for ALL sign-in failures so the error
      // text can't be used to enumerate accounts (invalid password vs unknown
      // email vs unconfirmed email all read identically).
      // US-380: the message also nudges users who originally signed up with a
      // different method (e.g. Google) toward "Continue with Google" — an
      // enumeration-safe hint shown on every failure, so it never confirms the
      // account exists.
      toast.error(SIGN_IN_FAILED_MESSAGE);
      // US-368: the Turnstile token was consumed by the failed attempt — reset
      // for the retry.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    try {
      await signInWithGoogle();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sign in with Google");
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your GradeThread account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
            <Input
              id="password"
              type="password"
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
          <TurnstileWidget
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            resetSignal={captchaReset}
          />
          <Button type="submit" className="w-full" disabled={isLoading}>
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
        >
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
        </Button>
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
