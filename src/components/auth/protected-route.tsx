import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { VerifyEmailGate } from "@/components/auth/verify-email-gate";
import { LegalGate } from "@/components/auth/legal-gate";
import { MfaSignInGate } from "@/components/auth/mfa-sign-in-gate";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

export function ProtectedRoute() {
  const { session, user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    // US-1430: preserve the attempted deep-link so the user lands back on it
    // after signing in (LoginPage / the OAuth callback consume `?next=`).
    const attempted = location.pathname + location.search;
    const to =
      attempted && attempted !== "/"
        ? `/login?next=${encodeURIComponent(attempted)}`
        : "/login";
    return <Navigate to={to} replace />;
  }

  // US-366: a session whose email is unverified can't use the app (the edge
  // rejects its requests with 403). Show a confirm-your-email gate + resend
  // instead of letting every data fetch fail.
  if (user && !user.email_confirmed_at) {
    return <VerifyEmailGate email={user.email ?? null} />;
  }

  // US-377: block dashboard access until the user has affirmatively accepted the
  // CURRENT ToS/Privacy versions. Captures consent for OAuth signups before
  // first access and forces re-acceptance after a material change. No-op once
  // the recorded versions match.
  // US-437: provides the branded, focus-managed useConfirm() to every
  // authenticated page (dashboard + admin), replacing native window.confirm.
  // US-3497: a user with a verified second factor is held on a code screen
  // until this session reaches AAL2. Before the legal gate, so nothing behind
  // it (including the legal-acceptance fetch) runs on a password-only session.
  // A user with no factor passes through with no extra screen.
  return (
    <MfaSignInGate sessionKey={session.access_token ?? null}>
      <LegalGate>
        <ConfirmProvider>
          <Outlet />
        </ConfirmProvider>
      </LegalGate>
    </MfaSignInGate>
  );
}
