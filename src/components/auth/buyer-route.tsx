import { Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";

// US-1802: guards the buyer app (/buyer/*). Nested INSIDE ProtectedRoute, so
// session / email-verification / legal-consent are already enforced upstream and
// the ConfirmProvider is in scope — this only checks the buyer role (US-1796).
// A non-buyer (seller-only) account is sent to the seller dashboard; the buyer
// role is granted by the buyer signup funnel (US-1797) or an in-app opt-in.
export function BuyerRoute() {
  const { profile, isLoading } = useAuth();
  const hasShownToast = useRef(false);
  const isBuyer = profile?.is_buyer === true;

  useEffect(() => {
    if (!isLoading && profile && !isBuyer && !hasShownToast.current) {
      hasShownToast.current = true;
      toast.error("Your account isn't set up as a buyer yet.");
    }
  }, [isLoading, profile, isBuyer]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isBuyer) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
