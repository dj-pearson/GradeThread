import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useEffect, useRef } from "react";

export function AdminRoute() {
  const { session, profile, isLoading } = useAuth();
  const hasShownToast = useRef(false);

  const isAdmin = profile?.role === "admin" || profile?.role === "super_admin";

  useEffect(() => {
    if (!isLoading && session && !isAdmin && !hasShownToast.current) {
      hasShownToast.current = true;
      toast.error("Access denied");
    }
  }, [isLoading, session, isAdmin]);

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

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
