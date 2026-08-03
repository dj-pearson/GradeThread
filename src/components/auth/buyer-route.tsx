import { Navigate, Outlet } from "react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";

// US-1802/1888: guards the buyer app (/buyer/*). Nested INSIDE ProtectedRoute,
// so session / email-verification / legal-consent are already enforced upstream
// and the ConfirmProvider is in scope. Etsy-style: ANY account that carries the
// buyer role OR the seller role may open the buyer app — a seller's plan bundles
// buyer functions (US-1887), so sellers shop without a separate purchase; buyer
// surfaces still gate on entitlements. Only a roleless account is turned away.
export function BuyerRoute() {
  const { profile, isLoading } = useAuth();
  const hasShownToast = useRef(false);
  const canAccessBuyer = profile?.is_buyer === true || profile?.is_seller === true;

  useEffect(() => {
    if (!isLoading && profile && !canAccessBuyer && !hasShownToast.current) {
      hasShownToast.current = true;
      toast.error("Your account isn't set up yet.");
    }
  }, [isLoading, profile, canAccessBuyer]);

  // `isLoading` only tracks the first bootstrap load; on a deep-link SPA sign-in
  // the SIGNED_IN event sets the session while `profile` is still null in flight.
  // Judging `canAccessBuyer` off a null profile would bounce a legitimate buyer,
  // so wait for the profile to resolve before evaluating access.
  if (isLoading || !profile) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!canAccessBuyer) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
