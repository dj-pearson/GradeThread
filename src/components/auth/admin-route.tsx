import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useEffect, useRef } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

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
