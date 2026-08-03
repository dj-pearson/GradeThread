import { Navigate, Outlet } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useEffect, useRef } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { VerifyEmailGate } from "@/components/auth/verify-email-gate";

export function AdminRoute() {
  const { session, user, profile, isLoading } = useAuth();
  const hasShownToast = useRef(false);

  const isAdmin = profile?.role === "admin" || profile?.role === "super_admin";

  useEffect(() => {
    // Only judge the role once the profile has actually loaded — see the
    // `session && !profile` spinner below.
    if (!isLoading && session && profile && !isAdmin && !hasShownToast.current) {
      hasShownToast.current = true;
      toast.error("Access denied");
    }
  }, [isLoading, session, profile, isAdmin]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  // Parity with ProtectedRoute (US-366): the admin tree is a SIBLING of
  // ProtectedRoute, so its email-verification gate never ran for /admin/*. An
  // unconfirmed-email admin could render the shell (the edge still 403s its API
  // calls). Enforce the same gate here.
  if (user && !user.email_confirmed_at) {
    return <VerifyEmailGate email={user.email ?? null} />;
  }

  // The profile load is async and independent of `isLoading` (which only tracks
  // the very first bootstrap load, and stays false on subsequent SPA sign-ins).
  // On a deep-link sign-in the SIGNED_IN event sets `session` synchronously while
  // `profile` is still null in flight — evaluating `isAdmin` here would read
  // false and hard-bounce a legitimate admin with a spurious "Access denied".
  // Wait for the profile to resolve before judging the role.
  if (!profile) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  // US-437: the admin tree is a sibling of ProtectedRoute (not nested under it),
  // so it needs its own ConfirmProvider — admin pages (blog/social editors) call
  // useConfirm() and would otherwise crash with "must be used within a
  // <ConfirmProvider>".
  return (
    <ConfirmProvider>
      <Outlet />
    </ConfirmProvider>
  );
}
