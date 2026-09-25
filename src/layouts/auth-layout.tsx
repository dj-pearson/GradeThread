import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "@/hooks/use-auth";

export function AuthLayout() {
  const { session, profile, isLoading } = useAuth();
  const location = useLocation();
  // A recovery link opened in a browser that is already signed in still has
  // to reach the form. "Set a password" in Settings (for Google/Apple
  // accounts) sends exactly that link to someone who is signed in, and
  // bouncing them to /dashboard made the email a dead end. Only the branded
  // token_hash link passes: the page verifies it, which replaces the session
  // with the recovery one, so the form never acts on the old session.
  const isRecoveryLink =
    location.pathname === "/auth/reset-password" &&
    new URLSearchParams(location.search).has("token_hash");

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (session && !isRecoveryLink) {
    // US-1797: a buyer-only account (no seller role) belongs in the buyer app,
    // not the seller dashboard. Dual-role accounts default to the seller
    // dashboard and switch to /buyer from the sidebar.
    const dest = profile?.is_buyer && !profile?.is_seller ? "/buyer" : "/dashboard";
    return <Navigate to={dest} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <img src="/logo_primary.png" width={1806} height={376} alt="GradeThread" className="h-10" />
        </div>
        <Outlet />
      </div>
    </div>
  );
}
