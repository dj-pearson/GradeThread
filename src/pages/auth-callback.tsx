import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { isIdentityLinkingError, OAUTH_LINKING_MESSAGE } from "@/lib/auth-identity";
import { PENDING_INVITE_KEY } from "@/pages/accept-invite";

// How long to wait for the auth exchange to complete before giving up and
// showing an error instead of an indefinite spinner (US-370).
const CALLBACK_TIMEOUT_MS = 15_000;

// OAuth/recovery errors can arrive as query params OR in the URL hash fragment
// (implicit flow). Read both.
function readAuthError(): { error: string; description: string | null } | null {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = query.get("error") ?? hash.get("error");
  if (!error) return null;
  const description =
    query.get("error_description") ?? hash.get("error_description");
  return { error, description };
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const goAfterSignIn = useCallback(() => {
    // If the user got here through a workspace invitation, send them back to
    // /accept-invite to complete the join (peek_workspace_invitation is
    // idempotent, so a double-mount is safe).
    const pendingToken = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (pendingToken) {
      navigate(`/accept-invite?token=${pendingToken}`, { replace: true });
      return;
    }
    navigate("/dashboard", { replace: true });
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
    //    infinite spinner.
    const timer = window.setTimeout(() => {
      finish(() =>
        setErrorMessage(
          "Sign-in is taking longer than expected. Please try signing in again.",
        )
      );
    }, CALLBACK_TIMEOUT_MS);

    return () => {
      settled = true;
      sub.subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, [goAfterSignIn, navigate]);

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
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="mt-4 text-sm text-muted-foreground">
          Completing sign in...
        </p>
      </div>
    </div>
  );
}
