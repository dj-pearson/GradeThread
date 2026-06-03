import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { VerifyEmailGate } from "@/components/auth/verify-email-gate";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

export function ProtectedRoute() {
  const { session, user, isLoading } = useAuth();

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

  // US-366: a session whose email is unverified can't use the app (the edge
  // rejects its requests with 403). Show a confirm-your-email gate + resend
  // instead of letting every data fetch fail.
  if (user && !user.email_confirmed_at) {
    return <VerifyEmailGate email={user.email ?? null} />;
  }

  // US-437: provides the branded, focus-managed useConfirm() to every
  // authenticated page (dashboard + admin), replacing native window.confirm.
  return (
    <ConfirmProvider>
      <Outlet />
    </ConfirmProvider>
  );
}
