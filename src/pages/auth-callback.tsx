import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { supabase } from "@/lib/supabase";
import { isIdentityLinkingError, OAUTH_LINKING_MESSAGE } from "@/lib/auth-identity";
import { readAuthError } from "@/lib/auth-error";
import { PENDING_INVITE_KEY } from "@/pages/accept-invite";
import { RETURN_TO_KEY, sanitizeReturnTo } from "@/lib/return-to";
import { isCrossDeviceConfirmation } from "@/lib/auth-pkce";
import { track } from "@/lib/analytics";
import { SEO } from "@/components/seo";

// How long to wait for the auth exchange to complete before giving up and
// showing an error instead of an indefinite spinner (US-370).
const CALLBACK_TIMEOUT_MS = 15_000;

// GT-001: when the code cannot be spent in this browser at all, waiting the full
// fifteen seconds only delays the same answer. Still a wait rather than an
// instant verdict: supabase-js may have exchanged the code and cleared the
// verifier before this component mounted, and that success shows up as a session
// within a beat. Anything real resolves well inside four seconds.
const CROSS_DEVICE_TIMEOUT_MS = 4_000;

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Read once, on mount: the verifier is deleted by a SUCCESSFUL exchange, so a
  // later read would call a completed sign-in a cross-device failure.
  const [crossDevice] = useState(() =>
    isCrossDeviceConfirmation(window.location.search),
  );
  const [crossDeviceHelp, setCrossDeviceHelp] = useState(false);

  const goAfterSignIn = useCallback(() => {
    // If the user got here through a workspace invitation, send them back to
    // /accept-invite to complete the join (peek_workspace_invitation is
    // idempotent, so a double-mount is safe).
    const pendingToken = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (pendingToken) {
      navigate(`/accept-invite?token=${pendingToken}`, { replace: true });
      return;
    }
    // US-1430: return the user to the deep-link they were trying to reach
    // before being bounced to login (stashed by LoginPage across the OAuth
    // round-trip). Validate it's internal; clear it either way; fall back to
    // /dashboard.
    const returnTo = sanitizeReturnTo(sessionStorage.getItem(RETURN_TO_KEY));
    sessionStorage.removeItem(RETURN_TO_KEY);
    navigate(returnTo ?? "/dashboard", { replace: true });
  }, [navigate]);

  useEffect(() => {
    // 1. Surface an explicit provider error immediately.
    const authError = readAuthError();
    if (authError) {
      // US-380: a duplicate-account / identity-linking error means this email
      // already belongs to an account created with a different method that
      // GoTrue couldn't auto-link. Guide the user back to their original method
      // instead of dumping the raw provider error.
      setErrorMessage(
        isIdentityLinkingError(authError.error, authError.description)
          ? OAUTH_LINKING_MESSAGE
          : authError.description ||
              "Sign-in could not be completed. Please try again.",
      );
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // 2. The session may already be established by the time we mount (the
    //    detectSessionInUrl exchange can resolve before the listener attaches),
    //    so check it directly rather than relying solely on the event.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) finish(goAfterSignIn);
    });

    // 3. Listen for the sign-in completing.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") {
        finish(goAfterSignIn);
      } else if (event === "SIGNED_OUT") {
        finish(() => navigate("/login", { replace: true }));
      }
    });

    // 4. Timeout fallback so a stalled exchange never leaves the user on an
    //    infinite spinner. GT-001: a code this browser cannot spend gets the
    //    shorter wait and a different answer — "try again" is advice that cannot
    //    work, and it was the last thing a lost signup ever read.
    const timer = window.setTimeout(() => {
      finish(() => {
        if (crossDevice) {
          track("signup.verify_failed", { reason: "cross_device_pkce" });
          setErrorMessage(null);
          setCrossDeviceHelp(true);
          return;
        }
        track("signup.verify_failed", { reason: "callback_timeout" });
        setErrorMessage(
          "Sign-in is taking longer than expected. Please try signing in again.",
        );
      });
    }, crossDevice ? CROSS_DEVICE_TIMEOUT_MS : CALLBACK_TIMEOUT_MS);

    return () => {
      settled = true;
      sub.subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, [goAfterSignIn, navigate, crossDevice]);

  // GT-001: the link works, it just cannot finish HERE. Say that, and give the
  // two routes that do work from this device.
  if (crossDeviceHelp) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <SEO title="Finish confirming your email" noindex />
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-brand-navy dark:text-foreground">
            Finish this on the device you signed up on
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This link completes in the browser that started the signup, and it
            was opened somewhere else. Nothing is wrong with your account.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Either open the same link in that browser, or enter the 6-digit code
            from the email here instead.
          </p>
          <Link
            to="/auth/confirm"
            className="mt-4 inline-block text-sm font-medium text-brand-red-text hover:underline"
          >
            Enter the code from the email
          </Link>
          <p className="mt-4 text-xs text-muted-foreground">
            Already confirmed?{" "}
            <Link to="/login" className="font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-brand-navy dark:text-foreground">
            Sign-in failed
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{errorMessage}</p>
          <Link
            to="/login"
            className="mt-4 inline-block text-sm font-medium text-brand-red-text hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background px-4">
      {/* US-2529: noindex — the OAuth callback carries a code in the URL. */}
      <SEO title="Signing you in" noindex />
      <div className="text-center">
        <img
          src="/logo_primary.png"
          width={1806}
          height={376}
          alt="GradeThread"
          className="mx-auto mb-8 h-10"
        />
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="mt-4 text-sm text-muted-foreground">Signing you in…</p>
      </div>
    </div>
  );
}
