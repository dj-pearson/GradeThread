import { Navigate, Outlet } from "react-router";
import { useAuth } from "@/hooks/use-auth";

export function AuthLayout() {
  const { session, profile, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (session) {
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
          <img src="/logo_primary.png" alt="GradeThread" className="h-10" />
        </div>
        <Outlet />
      </div>
    </div>
  );
}
