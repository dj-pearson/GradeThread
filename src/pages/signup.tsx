import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Rocket } from "lucide-react";
import { signUpWithEmail, signInWithGoogle } from "@/lib/auth";
import { checkPassword, PASSWORD_HINT } from "@/lib/password-policy";
import { CURRENT_LEGAL_VERSION } from "@/lib/constants";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmation, setIsConfirmation] = useState(false);
  // US-377: affirmative clickwrap consent — required before account creation.
  const [agreed, setAgreed] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // US-367: client mirror of the server password policy (server is authoritative).
    const pwCheck = checkPassword(password);
    if (!pwCheck.ok) {
      toast.error(pwCheck.reason ?? "Password does not meet the requirements");
      return;
    }
    // US-377: block account creation until the user affirmatively accepts.
    if (!agreed) {
      toast.error("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setIsLoading(true);
    try {
      const data = await signUpWithEmail(email, password, fullName, CURRENT_LEGAL_VERSION);
      setIsConfirmation(true);

      // US-219: every new signup is granted a 14-day Pro trial by the
      // handle_new_user trigger. Record the trial start (consent-gated no-op
      // until the visitor opts in).
      track("trial.started", { plan: "pro", trial_days: 14 });

      // Send welcome email (fire-and-forget)
      if (data?.user?.id && EDGE_URL) {
        fetch(`${EDGE_URL}/api/notifications/welcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: data.user.id }),
        }).catch(() => {});
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
      }
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
        <CardTitle className="text-2xl">Create an account</CardTitle>
        <CardDescription>Start grading clothes with AI today</CardDescription>
      </CardHeader>
      <CardContent>
        {PRE_LAUNCH && (
          <div className="mb-5 flex items-start gap-3 rounded-md border border-brand-red/30 bg-brand-red/5 p-3 text-sm">
            <Rocket className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-red" />
            <div>
              <p className="font-semibold text-brand-navy">
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
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              placeholder="Jane Smith"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </div>
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
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder={PASSWORD_HINT}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={10}
            />
            <p className="text-xs text-muted-foreground">{PASSWORD_HINT}</p>
          </div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-brand-navy"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              aria-describedby="legal-consent"
            />
            <span id="legal-consent">
              I agree to the{" "}
              <Link to="/terms" className="underline hover:text-foreground">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link to="/privacy" className="underline hover:text-foreground">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || !agreed}
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

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Continuing with Google means you accept our{" "}
          <Link to="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link to="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
          ; we&apos;ll confirm on first sign-in.
        </p>
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-red hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
